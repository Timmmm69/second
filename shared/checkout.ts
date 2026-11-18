export const checkoutMethods = ["PICKUP", "EUROPOST", "BELPOST"] as const;
export type CheckoutMethod = typeof checkoutMethods[number];

export const shippingCostNotice = "Стоимость доставки уточняется при подтверждении заказа";

type RecipientFields = {
  phone: string;
  fullName?: string;
  city?: string;
  office?: string;
  officeAddress?: string;
  postalCode?: string;
  comment?: string;
};

export function recipientErrors(method: CheckoutMethod, fields: RecipientFields) {
  const errors: Record<string, string> = {};
  const phone = fields.phone.trim();
  if (!/^\+?[\d\s()-]{9,22}$/.test(phone) || !/^\d{9,15}$/.test(phone.replace(/\D/g, "")))
    errors.phone = "Укажите телефон для связи";
  if (method === "PICKUP") return errors;
  if ((fields.fullName?.trim().split(/\s+/).length ?? 0) < 2)
    errors.fullName = "Укажите фамилию и имя получателя";
  if (!fields.city?.trim()) errors.city = "Укажите населённый пункт";
  if (method === "BELPOST") {
    if (!fields.office?.trim() && !fields.officeAddress?.trim()) errors.office = "Укажите отделение или его адрес";
    if (fields.postalCode?.trim() && !/^\d{6}$/.test(fields.postalCode.trim())) errors.postalCode = "Укажите шестизначный индекс";
  }
  return errors;
}

export function orderRecipient(method: CheckoutMethod, fields: RecipientFields) {
  const postal = method !== "PICKUP";
  return {
    phone: fields.phone.trim(),
    fullName: postal ? fields.fullName?.trim() ?? "" : "",
    city: postal ? fields.city?.trim() ?? "" : "",
    office: postal ? fields.office?.trim() ?? "" : "",
    officeAddress: postal ? fields.officeAddress?.trim() ?? "" : "",
    postalCode: postal ? fields.postalCode?.trim() ?? "" : "",
    comment: fields.comment?.trim() ?? "",
  };
}
