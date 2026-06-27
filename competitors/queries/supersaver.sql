-- SQL Transformation Query to Standardize SuperSaver Raw Competitor Data
-- Target Schema: raw_competitor_products

INSERT INTO `fulfillment-dwh-production.price_guard.raw_competitor_products` (
  competitor,
  product_name,
  latest_price,
  source_type,
  attributes,
  collected_at
)
SELECT
  'supersaver' AS competitor,
  TRIM(Product_Name) AS product_name,
  SAFE_CAST(REPLACE(REPLACE(CAST(latest_price AS STRING), '₦', ''), ',', '') AS NUMERIC) AS latest_price,
  'partner' AS source_type,
  -- Pack extra variables like barcode, categories, and store metadata into a JSON block
  TO_JSON_STRING(STRUCT(
    product_barcode AS barcode,
    product_category_level_one AS category_level_one,
    product_category_level_two AS category_level_two,
    product_category_level_three AS category_level_three,
    store_name AS store_location
  )) AS attributes,
  CURRENT_TIMESTAMP() AS collected_at
FROM `fulfillment-dwh-production.external_competitor_data.supersaver_raw`
WHERE Product_Name IS NOT NULL 
  AND latest_price IS NOT NULL;
