export type PurchasePlan = {
  id: string
  price: number
  tickets: number
}

export const PURCHASE_PLANS: PurchasePlan[] = [
  { id: 'light', price: 599, tickets: 30 },
  { id: 'standard', price: 1799, tickets: 100 },
  { id: 'expert', price: 3999, tickets: 250 },
]
