import fetch from 'node-fetch';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'fs';

import { Convert } from "easy-currencies";

dotenv.config();

const SQUARESPACE_API_KEY = process.env.SQUARESPACE_API_KEY!;

if (!SQUARESPACE_API_KEY) {
  throw new Error("Missing required environment variables.");
}

namespace Squarespace {
  // TODO: use `zod`?
  export interface Variant {
    id: string;
    sku: string;
    pricing: {
      basePrice: {
        currency: string;
        value: string;
      };
      salePrice?: {
        currency: string;
        value: string;
      };
      onSale?: boolean;
    };
    stock?: {
      quantity: number;
      unlimited: boolean;
    };
    attributes?: Record<string, string>;
    image?: {
      id: string;
      title: string;
      url: string;
      originalSize: {
        width: number;
        height: number;
      };
      availableFormats: string[];
    };
  }

  export interface Product {
    id: string;
    type: 'PHYSICAL' | 'DIGITAL';
    name: string;
    description?: string;
    url: string;
    variants?: Variant[];
    pricing?: {
      basePrice: {
        currency: string;
        value: string;
      };
      salePrice?: {
        currency: string;
        value: string;
      };
      onSale?: boolean;
    };
  }

  export interface ProductResponse {
    products: Product[];
    pagination: {
      hasNextPage: boolean;
      nextPageCursor: string;
      nextPageUrl: string;
    };
  }

  const BASE_URL = 'https://api.squarespace.com/1.0/commerce/products';

  export async function getProducts(): Promise<Product[]> {
    let cursor = null;
    let products: Product[] = [];

    do {
      const url = new URL('https://api.squarespace.com/1.0/commerce/products');
      if (cursor) {
        url.searchParams.append('cursor', cursor);
      }

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${SQUARESPACE_API_KEY}`,
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json() as ProductResponse;
      products = products.concat(data.products);
      cursor = data.pagination?.nextPageCursor;
    } while (cursor);

    return products;
  }

  export async function updateProductVariant(
    productId: string,
    variantId: string,
    price: number,
  ): Promise<void> {
    const body = {
      pricing: {
        basePrice: {
          currency: 'AUD',
          value: price.toFixed(2)
        }
      }
    };

    const response = await fetch(`${BASE_URL}/${productId}/variants/${variantId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SQUARESPACE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Failed to update variant ${variantId}: ${errorText}`);
    }
  }

  export async function backupProducts(products: Product[]): Promise<void> {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15);
    const path = `backup-${timestamp}.json`;
    fs.writeFileSync(path, JSON.stringify(products, null, 2));
  }
}

namespace TCGPlayer {
  export async function scrapeCardPrices(cardName: string) {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
      ]
    });
    const page = await browser.newPage();
    try {
      await page.goto(`https://www.tcgplayer.com/search/all/products?q=${encodeURIComponent(cardName)}`, { waitUntil: 'domcontentloaded' });

      await page.waitForSelector('.product-card', { visible: true });

      const card = await page.evaluate((cardName) => {
        const cards = Array.from(document.querySelectorAll('.product-card'));
        const matchedCard = cards.find(card => {
          const title = card.querySelector('.product-card__title')?.textContent?.trim() || '';
          return cardName.toLowerCase().includes(title.toLowerCase());
        });
        return matchedCard ? matchedCard.querySelector('a')?.href : null;
      }, cardName);


      if (!card) {
        return null;
      }

      await page.goto(card, { waitUntil: 'domcontentloaded' });

      await page.waitForFunction(() => {
        const prices = Array.from(document.querySelectorAll('.near-mint-table__price'));
        return prices.length >= 2 && prices.every(el => (el.textContent || '').trim() !== '');
      });

      const { normalPriceUSD, foilPriceUSD } = await page.evaluate(() => {
        const prices = Array.from(document.querySelectorAll('.near-mint-table__price'));
        const normalPriceUSD = prices[0]?.textContent ? parseFloat(prices[0].textContent.replace(/[^\d.-]/g, '')) : null;
        const foilPriceUSD = prices[1]?.textContent ? parseFloat(prices[1].textContent.replace(/[^\d.-]/g, '')) : null;
        return { normalPriceUSD, foilPriceUSD };
      });

      const normalPrice = normalPriceUSD
        ? (await Convert(normalPriceUSD).from("USD").to("AUD")).toFixed(2)
        : null;

      const foilPrice = foilPriceUSD
        ? (await Convert(foilPriceUSD).from("USD").to("AUD")).toFixed(2)
        : null;

      return { normalPrice, foilPrice };
    } finally {
      await browser.close();
    }
  }
}

(async () => {
  try {
    const products = await Squarespace.getProducts();

    await Squarespace.backupProducts(products);

    for (const [index, product] of products.entries()) {
      console.group(`🔄 (${index + 1}/${products.length}) ${product.name}`);

      const prices = await TCGPlayer.scrapeCardPrices(product.name);
      if (!prices) {
        console.warn(`⚠️ No prices found for ${product.name}`);
        console.groupEnd();
        continue;
      }

      const nearMintVariant = product.variants?.find(v => v.attributes?.["Condition"] === "Near Mint");

      if (nearMintVariant && prices.normalPrice) {
        console.group("🃏 Near Mint");
        const oldPrice = parseFloat(nearMintVariant.pricing.basePrice.value);
        const newPrice = parseFloat(prices.normalPrice);
        if (oldPrice !== newPrice) {
          await Squarespace.updateProductVariant(product.id, nearMintVariant.id, newPrice);
          console.log(`✅ Update in price from $${oldPrice} → $${newPrice}`);
        } else {
          console.log(`⏸️ No change in price from $${oldPrice}`);
        }
        console.groupEnd();
      }

      const nearMintFoilVariant = product.variants?.find(v => v.attributes?.["Condition"] === "Near Mint Foil");
      if (nearMintFoilVariant && prices.foilPrice) {
        console.group("🃏✨ Near Mint Foil");
        const oldPrice = parseFloat(nearMintFoilVariant.pricing.basePrice.value);
        const newPrice = parseFloat(prices.foilPrice);
        if (oldPrice !== newPrice) {
          await Squarespace.updateProductVariant(product.id, nearMintFoilVariant.id, newPrice);
          console.log(`✅ Updated price from $${oldPrice} → $${newPrice}`);
        } else {
          console.log(`⏸️ No change in price from $${oldPrice}`);
        }
        console.groupEnd();
      }

      console.groupEnd();
    }

    console.log('🎉 All product prices updated');
  } catch (error) {
    console.error('❌ Error occurred:', error);
    process.exit(1);
  }
})();
