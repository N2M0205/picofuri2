// 送料辞書（CROSSMALL delivery_type_name → 送料）
const SHIPPING_COST_MAP = {
  '宅配便(日本郵便 楽天倉庫出荷)': 620,
  '追跡可能メール便(日本郵便)': 220,
  'メール便(日本郵便)': 340,
  '宅配便(佐川急便)': 550,
};
const DEFAULT_SHIPPING_COST = 620;

function getShippingCost(deliveryType) {
  if (!deliveryType) return DEFAULT_SHIPPING_COST;
  return SHIPPING_COST_MAP[deliveryType] ?? DEFAULT_SHIPPING_COST;
}

module.exports = { getShippingCost, SHIPPING_COST_MAP, DEFAULT_SHIPPING_COST };
