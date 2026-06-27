WITH date_ranges AS (
  SELECT
    DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 2 MONTH), MONTH) AS last_2_month_start,
    DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), MONTH) AS last_month_start,
    DATE_TRUNC(CURRENT_DATE(), MONTH) AS current_month_start,
    CURRENT_DATE() AS today
),

sales AS (
  SELECT
    s.product_sku,
    MAX(s.product_name_local) AS product_name,
    MAX(s.product_category_level_one) AS product_category_level_one,
    MAX(s.product_category_level_two) AS product_category_level_two,
    MAX(s.product_category_level_three) AS product_category_level_three,

    -- Selling Price Last 2 Months
    ARRAY_AGG(
      CASE
        WHEN DATE(s.p_order_activation_local_date) >= dr.last_2_month_start
         AND DATE(s.p_order_activation_local_date) < dr.current_month_start
        THEN s.product_unit_price_local_currency
      END
      IGNORE NULLS
      ORDER BY s.p_order_activation_local_date DESC
      LIMIT 1
    )[SAFE_OFFSET(0)] AS selling_price_last_2_months,

    -- Quantity Sold Last 2 Months
    COALESCE(SUM(
      CASE
        WHEN DATE(s.p_order_activation_local_date) >= dr.last_2_month_start
         AND DATE(s.p_order_activation_local_date) < dr.current_month_start
        THEN s.product_quantity_delivered
      END
    ), 0) AS quantity_sold_last_2_months,

    -- Revenue Last 2 Months
    COALESCE(SUM(
      CASE
        WHEN DATE(s.p_order_activation_local_date) >= dr.last_2_month_start
         AND DATE(s.p_order_activation_local_date) < dr.current_month_start
        THEN s.product_total_revenue_local_currency
      END
    ), 0) AS revenue_last_2_months,

    -- Selling Price Last Month
    ARRAY_AGG(
      CASE
        WHEN DATE(s.p_order_activation_local_date) >= dr.last_month_start
         AND DATE(s.p_order_activation_local_date) < dr.current_month_start
        THEN s.product_unit_price_local_currency
      END
      IGNORE NULLS
      ORDER BY s.p_order_activation_local_date DESC
      LIMIT 1
    )[SAFE_OFFSET(0)] AS selling_price_last_month,

    -- Quantity Sold Last Month
    COALESCE(SUM(
      CASE
        WHEN DATE(s.p_order_activation_local_date) >= dr.last_month_start
         AND DATE(s.p_order_activation_local_date) < dr.current_month_start
        THEN s.product_quantity_delivered
      END
    ), 0) AS quantity_sold_last_month,

    -- Revenue Last Month
    COALESCE(SUM(
      CASE
        WHEN DATE(s.p_order_activation_local_date) >= dr.last_month_start
         AND DATE(s.p_order_activation_local_date) < dr.current_month_start
        THEN s.product_total_revenue_local_currency
      END
    ), 0) AS revenue_last_month,

    -- Latest Selling Price
    ARRAY_AGG(
      s.product_unit_price_local_currency
      ORDER BY s.p_order_activation_local_date DESC
      LIMIT 1
    )[SAFE_OFFSET(0)] AS selling_price_today,

    -- Quantity Sold Latest (Last Month + Current Month to Date)
    COALESCE(SUM(
      CASE
        WHEN DATE(s.p_order_activation_local_date) >= dr.last_month_start
         AND DATE(s.p_order_activation_local_date) <= dr.today
        THEN s.product_quantity_delivered
      END
    ), 0) AS quantity_sold_latest,

    -- Revenue Latest
    COALESCE(SUM(
      CASE
        WHEN DATE(s.p_order_activation_local_date) >= dr.last_month_start
         AND DATE(s.p_order_activation_local_date) <= dr.today
        THEN s.product_total_revenue_local_currency
      END
    ), 0) AS revenue_latest

  FROM `fulfillment-dwh-production.curated_data_shared_glovo.mfc_sales__products_sold` s
  CROSS JOIN date_ranges dr
  WHERE s.country_code = 'NG'
    AND s.order_final_status = 'DeliveredStatus'
  GROUP BY 1
),

purchases AS (
  SELECT
    p.product_sku,
    MAX(p.product_name_local) AS product_name,
    MAX(p.supplier_name) AS supplier_name,
    MAX(p.product_category_level_one) AS product_category_level_one,
    MAX(p.product_category_level_two) AS product_category_level_two,
    MAX(p.product_category_level_three) AS product_category_level_three,

    -- Cost Price Last 2 Months
    ARRAY_AGG(
      CASE
        WHEN DATE(p.purchase_order_created_local_datetime) >= dr.last_2_month_start
         AND DATE(p.purchase_order_created_local_datetime) < dr.current_month_start
        THEN p.product_unit_cost_local_currency
      END
      IGNORE NULLS
      ORDER BY p.purchase_order_created_local_datetime DESC
      LIMIT 1
    )[SAFE_OFFSET(0)] AS cost_price_last_2_months,

    -- Cost Price Last Month
    ARRAY_AGG(
      CASE
        WHEN DATE(p.purchase_order_created_local_datetime) >= dr.last_month_start
         AND DATE(p.purchase_order_created_local_datetime) < dr.current_month_start
        THEN p.product_unit_cost_local_currency
      END
      IGNORE NULLS
      ORDER BY p.purchase_order_created_local_datetime DESC
      LIMIT 1
    )[SAFE_OFFSET(0)] AS cost_price_last_month,

    -- Latest Cost Price
    ARRAY_AGG(
      p.product_unit_cost_local_currency
      ORDER BY p.purchase_order_created_local_datetime DESC
      LIMIT 1
    )[SAFE_OFFSET(0)] AS cost_price_today

  FROM `fulfillment-dwh-production.curated_data_shared_glovo.mfc_products_purchased__products_purchased` p
  CROSS JOIN date_ranges dr
  WHERE p.country_code = 'NG'
  GROUP BY 1
)

SELECT
  COALESCE(p.product_sku, s.product_sku) AS product_sku,
  COALESCE(p.product_name, s.product_name) AS product_name,
  p.supplier_name,

  COALESCE(p.product_category_level_one, s.product_category_level_one) AS product_category_level_one,
  COALESCE(p.product_category_level_two, s.product_category_level_two) AS product_category_level_two,
  COALESCE(p.product_category_level_three, s.product_category_level_three) AS product_category_level_three,

  p.cost_price_last_2_months,
  s.selling_price_last_2_months,
  s.quantity_sold_last_2_months,
  s.revenue_last_2_months,

  p.cost_price_last_month,
  s.selling_price_last_month,
  s.quantity_sold_last_month,
  s.revenue_last_month,

  p.cost_price_today,
  s.selling_price_today,
  s.quantity_sold_latest,
  s.revenue_latest

FROM purchases p
FULL OUTER JOIN sales s
  ON p.product_sku = s.product_sku

ORDER BY product_name;