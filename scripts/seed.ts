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
      color: "Карамельный",
      artColor: "#b8794f",
      sizeLabel: "L",
      shape: "jacket",
    },
    {
      title: "Прямые джинсы",
      category: "trousers",
      price: 3500,
      color: "Серо-синий",
      artColor: "#536b86",
      sizeLabel: "M",
      shape: "pants",
    },
    {
      title: "Джемпер песочного цвета",
      category: "knit",
      price: 5200,
      color: "Песочный",
      artColor: "#d7c5a9",
      sizeLabel: "M",
      shape: "jacket",
    },
    {
      title: "Голубая рубашка",
      category: "shirts",
      price: 4200,
      color: "Светло-голубой",
      artColor: "#c5d3d9",
      sizeLabel: "S",
      shape: "shirt",
    },
    {
      title: "Детская кофта",
      category: "children",
      price: 2800,
      color: "Пыльно-розовый",
      artColor: "#d2b6b5",
      sizeLabel: "110",
      shape: "jacket",
    },
    {
      title: "Сумка на плечо",
      category: "bags",
      price: 6900,
      color: "Коричневый",
      artColor: "#97715a",
      sizeLabel: "",
      shape: "bag",
    },
    {
      title: "Шарф шалфейного цвета",
      category: "accessories",
      price: 1900,
      color: "Шалфейный",
      artColor: "#a9b6a1",
      sizeLabel: "",
      shape: "scarf",
    },
    {
      title: "Платье свободного кроя",
      category: "dresses",
      price: 6200,
      color: "Серо-бежевый",
      artColor: "#b4ad99",
      sizeLabel: "XL",
      shape: "dress",
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
    const svg = fixtureSvg(f.shape, f.artColor);
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
      sizeSystem: f.category === "children" ? "RU" : "INT",
      sizeLabel: f.sizeLabel,
    };
    await tx(async (c) => {
      await c.query(
        "INSERT INTO items(id,sku,title,category,price_minor,attributes,storage_location) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          itemId,
          "TEST-" + String(index + 1).padStart(4, "0"),
          f.title,
          f.category,
          f.price,
          attributes,
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
            measurements: {},
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
