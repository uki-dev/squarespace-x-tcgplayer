import fetch from 'node-fetch';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const SQUARESPACE_API_KEY = process.env.SQUARESPACE_API_KEY!;

if (!SQUARESPACE_API_KEY) {
  throw new Error("Missing required environment variables.");
}

namespace Squarespace {
  export interface Variant {
    id: string;
    sku: string;
    pricing: {
      basePrice: {
        currency: string;
        value: string;
      };
    };
  }

  export interface Product {
    id: string;
    name: string;
    variants: Variant[];
  }


  export interface ProductResponse {
    products: Product[];
  }

  const BASE_URL = 'https://api.squarespace.com/1.0/commerce/products';

  export async function getProducts(): Promise<Product[]> {
    const res = await fetch(BASE_URL, {
      headers: {
        Authorization: `Bearer ${SQUARESPACE_API_KEY}`
      }
    });

    const data = await res.json() as ProductResponse;
    return data.products;
  }

  export async function updateProductPrice(product: Product, newPrice: number): Promise<void> {
    if (product.variants.length === 0) {
      console.warn(`Product [${product.name}] has no variants to update.`);
      return;
    }

    const variant = product.variants[0];

    await fetch(`${BASE_URL}/${product.id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${SQUARESPACE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        variants: [
          {
            id: variant.id,
            price: newPrice
          }
        ]
      })
    });
  }

  export async function backupProducts(products: Product[]): Promise<void> {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15);
    const path = `backup-${timestamp}.json`;
    fs.writeFileSync(path, JSON.stringify(products, null, 2));
  }
}

namespace TCGPlayer {
  export async function scrapeCardPrice(cardName: string): Promise<number | null> {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
      ]
    });
    const page = await browser.newPage();
    try {
      const searchUrl = `https://www.tcgplayer.com/search/all/products?q=${encodeURIComponent(cardName)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.product-card');
      const price = await page.evaluate(() => {
        const firstProductCard = document.querySelector('.product-card');
        if (firstProductCard) {
          const priceElement = firstProductCard.querySelector('.product-card__market-price .product-card__market-price--value');
          if (priceElement) {
            const priceText = priceElement.textContent?.trim();
            const parsedPrice = parseFloat(priceText?.replace(/[^\d.-]/g, '') ?? '');
            return isNaN(parsedPrice) ? null : parsedPrice;
          }
        }
        return null;
      });
      return price;
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

      const oldPrice = product.variants.length > 0 && product.variants[0].pricing
        ? parseFloat(product.variants[0].pricing.basePrice.value)
        : null;
      const newPrice = await TCGPlayer.scrapeCardPrice(product.name);

      if (newPrice == null) {
        console.warn("⚠️ Failed to query price")
      }

      if (newPrice !== null && oldPrice !== null && oldPrice !== newPrice) {
        console.log(`✅ Price updated from $${oldPrice.toFixed(2)} to $${newPrice.toFixed(2)}`);
        await Squarespace.updateProductPrice(product, newPrice);
      }

      console.groupEnd();
    }

    console.log('🎉 All product prices updated');
  } catch (error) {
    console.error('❌ Error occurred:', error);
    process.exit(1);
  }
})();
