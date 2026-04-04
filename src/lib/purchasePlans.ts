export type PurchasePlan = {
  id: string
  label: string
  price: number
  tickets: number
  priceId: string
}

export const PURCHASE_PLANS: PurchasePlan[] = [
  { id: 'trial', label: 'お試しパック', price: 470, tickets: 25, priceId: 'price_1TIA1SAHjIANZ9z3a3U015UN' },
  { id: 'value', label: 'お得パック', price: 1980, tickets: 115, priceId: 'price_1TIA1jAHjIANZ9z3ReE5aAsV' },
  { id: 'mega', label: '大容量パック', price: 9980, tickets: 600, priceId: 'price_1TIA2LAHjIANZ9z3uNOI1ZQr' },
]
