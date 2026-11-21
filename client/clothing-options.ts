// Lightweight, editable suggestions. Unknown values are always allowed.
// No network request or extra dependency is necessary to populate these lists.
export const clothingColors = [
  "Белый", "Чёрный", "Серый", "Бежевый", "Коричневый", "Синий",
  "Голубой", "Зелёный", "Красный", "Розовый", "Фиолетовый",
  "Жёлтый", "Оранжевый", "Бордовый", "Хаки", "Разноцветный",
] as const;

export const clothingBrands = [
  "Adidas", "Nike", "Puma", "Reebok", "New Balance", "Zara",
  "H&M", "Bershka", "Pull&Bear", "Reserved", "Mango", "Uniqlo",
  "Levi’s", "Tommy Hilfiger", "Calvin Klein", "Hugo Boss", "Lacoste",
  "The North Face", "Columbia", "Massimo Dutti", "Stradivarius",
  "Cropp", "Sinsay", "House", "Hollister", "Gap",
  "GUESS", "Under Armour", "Converse", "Vans", "Zolla", "Ostin",
] as const;

export const clothingSeasons = ["Лето", "Зима", "Весна", "Осень", "Демисезон", "Всесезон"] as const;

// ISO 3166-1 alpha-2 countries and territories. Intl provides Russian CLDR
// names; sorting takes place AFTER localization, never by English codes.
const countryCodes = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ EC EE EG EH ER ES ET
FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ OM
PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA
RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
`.trim().split(/\s+/);

export function russianCountries(): string[] {
  const display = new Intl.DisplayNames(["ru"], { type: "region" });
  return [...new Set(countryCodes.map((code) => display.of(code) ?? code))]
    .sort((a, b) => a.localeCompare(b, "ru", { sensitivity: "base" }));
}

export function canonicalChoice(value: string, suggestions: readonly string[]): string {
  const clean = value.trim();
  const normalized = clean.toLocaleLowerCase("ru").replaceAll("ё", "е");
  return suggestions.find((choice) => choice.toLocaleLowerCase("ru").replaceAll("ё", "е") === normalized) ?? clean;
}
