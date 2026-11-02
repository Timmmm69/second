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
      title: "Тестовый бомбер",
      category: "outerwear",
      price: 4500,
      color: "#b8794f",
      shape: "jacket",
      measurements: { chest: 560, length: 650, sleeve: 610 },
    },
    {
      title: "Тестовые джинсы",
      category: "trousers",
      price: 3500,
      color: "#536b86",
      shape: "pants",
      measurements: { waist: 380, rise: 280, length: 1030, inseam: 760 },
    },
    {
      title: "Тестовый джемпер",
      category: "knit",
      price: 5200,
      color: "#d7c5a9",
      shape: "jacket",
      measurements: { chest: 540, length: 630, sleeve: 600 },
    },
    {
      title: "Тестовая рубашка",
      category: "shirts",
      price: 4200,
      color: "#c5d3d9",
      shape: "shirt",
      measurements: { chest: 520, length: 690, sleeve: 620 },
    },
    {
      title: "Тестовая детская кофта",
      category: "children",
      price: 2800,
      color: "#d2b6b5",
      shape: "jacket",
      measurements: { chest: 350, length: 430 },
    },
    {
      title: "Тестовая сумка",
      category: "bags",
      price: 6900,
      color: "#97715a",
      shape: "bag",
      measurements: { width: 310, height: 240, depth: 120, strap: 980 },
    },
    {
      title: "Тестовый шарф",
      category: "accessories",
      price: 1900,
      color: "#a9b6a1",
      shape: "scarf",
      measurements: { length: 1600, width: 300 },
    },
    {
      title: "Тестовое платье",
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
      brand: "Тестовый образец",
      color: f.color,
      material: "Тестовые сведения: хлопок",
      care: "Тестовые сведения: по бирке",
      manufacturer: "Тестовый изготовитель",
      importer: "Тестовый импортёр",
      origin: "Тестовая страна",
      documents: ["ТЕСТ — не документ товара"],
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
      if (index === 0) await c.query("UPDATE items SET has_defect=true,defect_description=$2 WHERE id=$1", [itemId, "ТЕСТ: небольшая затяжка на рукаве; пример раскрытия дефекта, не реальный товар"]);
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
            defectDescription: index === 0 ? "ТЕСТ: небольшая затяжка на рукаве; пример раскрытия дефекта, не реальный товар" : "",
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
      name: "Лучок · тестовая среда",
      address: initialStore.address,
      phone: initialStore.phone,
      telegramUsername: "",
      seller: "Тестовые реквизиты, не для публикации",
      acceptingOrders: true,
      documents: {
        privacy: "Тестовый документ. Реальные ПД не вводить.",
        reservation: "Тестовые условия: бесплатная бронь.",
        shipping: "Тестовые условия: ручная отправка, все расходы покупателя.",
        returns: "Тестовый документ. Не является правовой политикой.",
      },
      carriers: {
        BELPOST: {
          enabled: false,
          codConfirmed: false,
          returnsConfirmed: false,
          terms:
            "ТЕСТ: оплата при получении через почту; доставка, упаковка и комиссии за счёт получателя; суммы подтвердит сотрудник.",
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
            "ТЕСТ: оплата при получении через почту; доставка, упаковка и комиссии за счёт получателя; суммы подтвердит сотрудник.",
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

function fixtureSvg(shape: string, color: string) {
  const silhouettes: Record<string, string> = {
    jacket:
      "M360 270L280 300L170 550L275 590L340 440L340 1010Q480 1070 620 1010L620 440L685 590L790 550L680 300L600 270Q480 350 360 270Z",
    shirt:
      "M370 270L280 310L165 590L270 630L345 460L345 1010L615 1010L615 460L690 630L795 590L680 310L590 270L480 350Z",
    pants: "M315 270L645 270L670 1050L520 1050L480 590L440 1050L290 1050Z",
    bag: "M250 490Q240 450 290 430L670 430Q720 450 710 490L735 920Q480 1020 225 920ZM355 435L360 310Q480 170 600 310L605 435L565 435L560 330Q480 245 400 330L395 435Z",
    scarf:
      "M340 250L535 265L620 1040L430 1070ZM340 250L535 265L470 530L320 490Z",
    dress:
      "M390 250L570 250L610 420L565 590L700 1040Q480 1130 260 1040L395 590L350 420Z",
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1280" viewBox="0 0 960 1280"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#f0efed"/><stop offset="1" stop-color="#dedcd7"/></linearGradient><linearGradient id="cloth" x2="1"><stop stop-color="${color}"/><stop offset=".48" stop-color="${color}"/><stop offset=".52" stop-color="#ffffff" stop-opacity=".15"/><stop offset="1" stop-color="${color}"/></linearGradient><filter id="s"><feDropShadow dx="0" dy="16" stdDeviation="16" flood-opacity=".12"/></filter></defs><rect width="960" height="1280" fill="url(#bg)"/><path d="M480 180q-25-40 0-55q35-15 40 10q0 20-40 40v50M310 270L480 210L650 270" stroke="#9c9b95" stroke-width="8" fill="none" stroke-linejoin="round"/><path d="${silhouettes[shape] ?? silhouettes.jacket}" fill="url(#cloth)" stroke="#222222" stroke-opacity=".12" stroke-width="3" filter="url(#s)"/><path d="M480 350V1010" stroke="#222" stroke-opacity=".12" stroke-width="3"/><rect x="40" y="1155" width="880" height="75" rx="16" fill="#fff" fill-opacity=".85"/><text x="480" y="1203" text-anchor="middle" font-family="sans-serif" font-size="28" font-weight="700" fill="#222">ТЕСТОВОЕ ИЗОБРАЖЕНИЕ · НЕ ТОВАР</text></svg>`;
}
if (process.argv[1] && /(?:^|\/)seed\.(?:ts|js)$/.test(process.argv[1]))
  seedDemo()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Seed failed");
      process.exitCode = 1;
    })
    .finally(() => pool.end());
