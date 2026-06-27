interface Product {
    product_sku: string;
    product_name: string;
    supplier_name: string;

    product_category_level_one: string;
    product_category_level_two: string;
    product_category_level_three: string;

    cost_price_last_2_months: number;
    selling_price_last_2_months: number;
    quantity_sold_last_2_months: number;
    revenue_last_2_months: number;

    cost_price_last_month: number;
    selling_price_last_month: number;
    quantity_sold_last_month: number;
    revenue_last_month: number;

    cost_price_today: number;
    selling_price_today: number;
    quantity_sold_latest: number;
    revenue_latest: number;
}
export default Product;