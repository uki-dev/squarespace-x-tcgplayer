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
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ]
    });

    try {
      const page = await browser.newPage();
      // Spoof user agent to get around TCGplayers anti-scrape mechanisms
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');

      await page.goto(`https://www.tcgplayer.com/search/all/products?q=${encodeURIComponent(cardName)}`, { waitUntil: 'networkidle2' });

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
        return prices.length > 0 && prices.every(el => (el.textContent || '').trim() !== '');
      });

      const { normalPriceUSD, foilPriceUSD } = await page.evaluate(() => {
        const cells = Array.from(document.querySelectorAll('.near-mint-table tr td'));
        let normal = null, foil = null;

        for (let i = 0; i < cells.length; i += 2) {
          const label = cells[i]?.textContent?.trim();
          const priceText = cells[i + 1]?.querySelector('.near-mint-table__price')?.textContent;
          const price = priceText ? parseFloat(priceText.replace(/[^\d.-]/g, '')) : null;

          if (label === 'Normal:') normal = price;
          if (label === 'Foil:') foil = price;
        }

        return { normalPriceUSD: normal, foilPriceUSD: foil };
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
      if (!prices || (!prices.normalPrice && !prices.foilPrice)) {
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
