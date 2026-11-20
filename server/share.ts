import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "./db.js";
import { config } from "./config.js";

type PublicShareItem = {
  title: string;
  price_minor: number;
  physical: string;
  media_variants: Record<string, string> | null;
};

function html(value: string): string {
  return value.replace(/[&<>"']/g, (symbol) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[symbol]!);
}

/** Server-rendered Open Graph tags let Telegram show the actual item photograph.
 * Never interpolate unescaped item titles into HTML.
 */
export function renderItemSharePage({
  title, priceMinor, url, imageUrl, telegramUrl, browserUrl,
}: {
  title: string;
  priceMinor: number;
  url: string;
  imageUrl?: string;
  telegramUrl: string;
  browserUrl: string;
}): string {
  const price = new Intl.NumberFormat("ru-BY", { maximumFractionDigits: 2 }).format(priceMinor / 100) + " BYN";
  const description = `${price} · Секонд-хенд «Лучок», Минск. Наличие подтвердит магазин.`;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,follow">
<title>${html(title)} · Лучок</title>
<meta name="description" content="${html(description)}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="Лучок">
<meta property="og:title" content="${html(title)} · ${html(price)}">
<meta property="og:description" content="${html(description)}">
<meta property="og:url" content="${html(url)}">
${imageUrl ? `<meta property="og:image" content="${html(imageUrl)}">
<meta property="og:image:type" content="image/webp">` : ""}
<meta name="twitter:card" content="summary_large_image">
</head>
<body>
<main>
<h1>${html(title)}</h1>
<p>${html(price)}</p>
<p>Наличие и условия получения подтвердит магазин.</p>
<p><a href="${html(telegramUrl)}">Открыть вещь в Telegram</a></p>
<p><a href="${html(browserUrl)}">Открыть в браузере</a></p>
</main>
</body>
</html>`;
}

/** One indexed item lookup per shared-link visit, never per catalog view or swipe. */
export async function registerItemShare(app: FastifyInstance): Promise<void> {
  app.get("/share/items/:id", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { rows } = await pool.query<PublicShareItem>(
      `SELECT i.title, i.price_minor, i.physical,
        (SELECT m.variants FROM media_assets m
         WHERE m.item_id=i.id AND m.state='READY' AND m.role<>'MEASUREMENT'
         ORDER BY m.position,m.created_at LIMIT 1) AS media_variants
       FROM items i WHERE i.id=$1 AND i.publication='PUBLISHED'`,
      [id],
    );
    const item = rows[0];
    if (!item) return reply.code(404).send({ code: "NOT_FOUND", message: "Вещь не найдена" });

    const browserUrl = new URL(`/#/items/${id}`, config.origin).toString();
    const url = new URL(`/share/items/${id}`, config.origin).toString();
    const botUrl = config.botUsername
      ? `https://t.me/${config.botUsername}?startapp=item_${id}`
      : browserUrl;
    // Public photos become protected again when stock leaves the public lifecycle.
    const image = ["AVAILABLE", "PICKED", "PACKED"].includes(item.physical)
      ? (item.media_variants?.["960"] ?? item.media_variants?.["480"] ?? item.media_variants?.["240"])
      : undefined;
    const imageUrl = image?.startsWith("/media/") ? new URL(image, config.origin).toString() : undefined;
    reply.header("Cache-Control", "public, max-age=30");
    return reply.type("text/html; charset=utf-8").send(renderItemSharePage({
      title: item.title,
      priceMinor: item.price_minor,
      url,
      imageUrl,
      telegramUrl: botUrl,
      browserUrl,
    }));
  });
}
