import { fixtureSvg } from "../shared/fixture-art.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { pool, tx } from "../server/db.js";
import { config } from "../server/config.js";
import { initialStore } from "../server/store-initial.js";
import { setPhysical } from "../server/inventory.js";

/** Isolated local fixtures only. Never copy the design reference into stock. */
export async function seedDemo(env = process.env) {
  const database = new URL(config.databaseUrl).pathname.slice(1);
  if (
    env.NODE_ENV === "production" ||
    !config.localDev ||
    env.ALLOW_DEV_SEED !== "1" ||
    !/_(?:dev|test)$/.test(database)
  ) {
    throw new Error(
      "Seed разрешён только APP_MODE=local + ALLOW_DEV_SEED=1 в отдельной БД *_dev или *_test, вне production.",
    );
  }
  const real = (
    await pool.query("SELECT 1 FROM items WHERE sku NOT LIKE 'TEST-%' LIMIT 1")
  ).rowCount;
  if (real)
    throw new Error("В базе есть не тестовые вещи. Seed не выполнялся.");
  const existing = (
    await pool.query(
      "SELECT count(*)::int count FROM items WHERE sku LIKE 'TEST-%'",
    )
  ).rows[0].count;
  if (existing > 0) {
    console.log("Тестовый каталог уже существует; данные не изменены.");
    return;
  }
  const fixtures = [
    {
      title: "Бомбер карамельного цвета",
      category: "outerwear",
      price: 4500,
      color: "#b8794f",
      shape: "jacket",
      measurements: { chest: 560, length: 650, sleeve: 610 },
    },
    {
      title: "Прямые джинсы",
      category: "trousers",
      price: 3500,
      color: "#536b86",
      shape: "pants",
      measurements: { waist: 380, rise: 280, length: 1030, inseam: 760 },
    },
    {
      title: "Джемпер песочного цвета",
      category: "knit",
      price: 5200,
      color: "#d7c5a9",
      shape: "jacket",
      measurements: { chest: 540, length: 630, sleeve: 600 },
    },
    {
      title: "Голубая рубашка",
      category: "shirts",
      price: 4200,
      color: "#c5d3d9",
      shape: "shirt",
      measurements: { chest: 520, length: 690, sleeve: 620 },
    },
    {
      title: "Детская кофта",
      category: "children",
      price: 2800,
      color: "#d2b6b5",
      shape: "jacket",
      measurements: { chest: 350, length: 430 },
    },
    {
      title: "Сумка на плечо",
      category: "bags",
      price: 6900,
      color: "#97715a",
      shape: "bag",
      measurements: { width: 310, height: 240, depth: 120, strap: 980 },
    },
    {
      title: "Шарф шалфейного цвета",
      category: "accessories",
      price: 1900,
      color: "#a9b6a1",
      shape: "scarf",
      measurements: { length: 1600, width: 300 },
    },
    {
      title: "Платье свободного кроя",
      category: "dresses",
      price: 6200,
      color: "#b4ad99",
      shape: "dress",
      measurements: { chest: 470, waist: 380, length: 1020 },
    },
  ];
  const owner = (
    await pool.query(
      "INSERT INTO users(telegram_id,role,display_name,allow_bot) VALUES(990000003,'OWNER','Тестовый владелец',false) ON CONFLICT(telegram_id) DO UPDATE SET display_name=excluded.display_name RETURNING id",
    )
  ).rows[0].id as string;
  await pool.query(
    "INSERT INTO users(telegram_id,role,display_name,allow_bot) VALUES(990000001,'BUYER','Тестовый покупатель',false),(990000002,'STAFF','Тестовый сотрудник',false) ON CONFLICT(telegram_id) DO NOTHING",
  );
  for (const [index, f] of fixtures.entries()) {
    const itemId = randomUUID(),
      mediaId = randomUUID();
    const svg = fixtureSvg(f.shape, f.color);
    const original = await sharp(Buffer.from(svg))
      .rotate()
      .toColourspace("srgb")
      .webp({ quality: 92 })
      .toBuffer();
    const folder = path.join(config.mediaDir, mediaId);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "original.webp"), original);
    const variants: Record<string, string> = {};
    for (const width of [240, 480, 960, 1600]) {
      await sharp(original)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 84 })
        .toFile(path.join(folder, width + ".webp"));
      variants[String(width)] = `/media/${mediaId}/${width}`;
    }
    const attributes = {
      brand: "",
      color: f.color,
      material: "",
      care: "",
      manufacturer: "",
      importer: "",
      origin: "",
      documents: [""],
      season: "Всесезон",
      audience: f.category === "children" ? "Детское" : "Унисекс",
      sizeSystem: "INT",
      sizeLabel: f.category === "children" ? "110" : "M",
      ...(f.category === "children" ? { height: 110 } : {}),
    };
    await tx(async (c) => {
      await c.query(
        "INSERT INTO items(id,sku,title,category,price_minor,attributes,measurements,storage_location) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          itemId,
          "TEST-" + String(index + 1).padStart(4, "0"),
          f.title,
          f.category,
          f.price,
          attributes,
          f.measurements,
          "Тестовая стойка " + (index + 1),
        ],
      );
      if (index === 0) await c.query("UPDATE items SET has_defect=true,defect_description=$2 WHERE id=$1", [itemId, "Небольшая затяжка на правом рукаве."]);
      await c.query(
        "INSERT INTO media_assets(id,item_id,original_key,checksum,mime,width,height,variants,position,role,state) VALUES($1,$2,$3,$4,$5,960,1280,$6,0,'FRONT','READY')",
        [
          mediaId,
          itemId,
          mediaId + "/original.webp",
          createHash("sha256").update(original).digest("hex"),
          "image/webp",
          variants,
        ],
      );
      await setPhysical(
        c,
        [itemId],
        "AVAILABLE",
        owner,
        "isolated development fixture",
      );
      await c.query(
        "UPDATE items SET publication='PUBLISHED',published_snapshot=$2 WHERE id=$1",
        [
          itemId,
          {
            hasDefect: index === 0,
            defectDescription: index === 0 ? "Небольшая затяжка на правом рукаве." : "",
            title: f.title,
            priceMinor: f.price,
            attributes,
            measurements: f.measurements,
          },
        ],
      );
    });
  }
  await tx(async (c) => {
    const row = (
      await c.query("SELECT value,version FROM store_settings WHERE id=true FOR UPDATE")
    ).rows[0];
    if (row.version > 2) return; // Seed never overwrites configured/initialized settings.
    const value = {
      ...row.value,
      ...initialStore,
      name: "Лучок",
      address: initialStore.address,
      phone: initialStore.phone,
      telegramUsername: "",
      seller: "Тестовые реквизиты, не для публикации",
      acceptingOrders: true,
      documents: initialStore.documents,
      carriers: {
        BELPOST: {
          enabled: false,
          codConfirmed: false,
          returnsConfirmed: false,
          terms:
            "Стоимость доставки, упаковки, комиссии и порядок оплаты согласуются до отправки.",
          contract: "",
          verifiedAt: "",
          paymentScheme:
            "ТЕСТ: товары наложенным платежом, услуги почты за счёт получателя.",
          returnsScheme:
            "ТЕСТ: обратное движение и возврат по подтверждению оператора.",
          partialDelivery: false,
        },
        EUROPOST: {
          enabled: true,
          codConfirmed: false,
          returnsConfirmed: false,
          terms:
            "Стоимость доставки, упаковки, комиссии и порядок оплаты согласуются до отправки.",
          contract: "",
          verifiedAt: "",
          paymentScheme:
            "ТЕСТ: товары наложенным платежом, услуги почты за счёт получателя.",
          returnsScheme:
            "ТЕСТ: обратное движение и возврат по подтверждению оператора.",
          partialDelivery: false,
        },
      },
    };
    await c.query(
      "UPDATE store_settings SET value=$1,version=version+1,updated_at=now() WHERE id=true",
      [value],
    );
  });
  console.log(
    "Созданы 8 явно тестовых вещей и локальные роли в изолированной БД. Сообщения и посылки не отправлялись.",
  );
}


if (process.argv[1] && /(?:^|\/)seed\.(?:ts|js)$/.test(process.argv[1]))
  seedDemo()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Seed failed");
      process.exitCode = 1;
    })
    .finally(() => pool.end());
