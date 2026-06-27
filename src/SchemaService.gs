/**
 * SchemaService
 * Auto-provisions BigQuery tables on first run or daily trigger.
 * Ensures all required tables exist before any data pipeline step.
 */
var SchemaService = (function() {

  /**
   * Ensure all required BigQuery tables exist.
   * Uses CREATE TABLE IF NOT EXISTS — safe to call repeatedly.
   * @returns {Object} Status report of each table creation.
   */
  function ensureTablesExist() {
    var results = {
      internal_products: false,
      raw_competitor_products: false,
      product_matches: false,
      computed_daily_metrics: false,
      daily_alerts: false
    };

    if (!BigQueryService.useBigQuery()) {
      Logger.log("SchemaService: Not in BigQuery mode. Schema bootstrap skipped.");
      // Return all true since mock/spreadsheet modes don't need DDL
      for (var key in results) { results[key] = true; }
      return results;
    }

    var dataset = BigQueryService.getDataset();

    // Ensure the dataset exists first
    ensureDatasetExists(dataset);

    // 1. Internal Products (Glovo catalog snapshot)
    results.internal_products = BigQueryService.executeDDL(
      "CREATE TABLE IF NOT EXISTS `" + dataset + ".internal_products` (\n" +
      "  product_sku STRING,\n" +
      "  product_name STRING,\n" +
      "  supplier_name STRING,\n" +
      "  product_category_level_one STRING,\n" +
      "  product_category_level_two STRING,\n" +
      "  product_category_level_three STRING,\n" +
      "  cost_price_last_2_months NUMERIC,\n" +
      "  selling_price_last_2_months NUMERIC,\n" +
      "  quantity_sold_last_2_months NUMERIC,\n" +
      "  revenue_last_2_months NUMERIC,\n" +
      "  cost_price_last_month NUMERIC,\n" +
      "  selling_price_last_month NUMERIC,\n" +
      "  quantity_sold_last_month NUMERIC,\n" +
      "  revenue_last_month NUMERIC,\n" +
      "  cost_price_today NUMERIC,\n" +
      "  selling_price_today NUMERIC,\n" +
      "  quantity_sold_latest NUMERIC,\n" +
      "  revenue_latest NUMERIC\n" +
      ")"
    );

    // 2. Raw Competitor Products (unified competitor listings)
    results.raw_competitor_products = BigQueryService.executeDDL(
      "CREATE TABLE IF NOT EXISTS `" + dataset + ".raw_competitor_products` (\n" +
      "  competitor STRING,\n" +
      "  product_name STRING,\n" +
      "  latest_price NUMERIC,\n" +
      "  source_type STRING,\n" +
      "  attributes STRING,\n" +
      "  collected_at TIMESTAMP\n" +
      ")"
    );

    // 3. Product Matches (persistent match cache)
    results.product_matches = BigQueryService.executeDDL(
      "CREATE TABLE IF NOT EXISTS `" + dataset + ".product_matches` (\n" +
      "  product_sku STRING,\n" +
      "  competitor STRING,\n" +
      "  competitor_product_name STRING,\n" +
      "  latest_price NUMERIC,\n" +
      "  confidence_score NUMERIC,\n" +
      "  match_method STRING,\n" +
      "  match_explanation STRING,\n" +
      "  is_approved BOOLEAN,\n" +
      "  needs_rematch BOOLEAN,\n" +
      "  last_matched_date TIMESTAMP\n" +
      ")"
    );

    // 4. Computed Daily Metrics (precomputed dashboard data)
    results.computed_daily_metrics = BigQueryService.executeDDL(
      "CREATE TABLE IF NOT EXISTS `" + dataset + ".computed_daily_metrics` (\n" +
      "  snapshot_date DATE,\n" +
      "  product_sku STRING,\n" +
      "  product_name STRING,\n" +
      "  supplier_name STRING,\n" +
      "  category_level_1 STRING,\n" +
      "  category_level_2 STRING,\n" +
      "  category_level_3 STRING,\n" +
      "  selling_price_today NUMERIC,\n" +
      "  cost_price_today NUMERIC,\n" +
      "  selling_price_last_month NUMERIC,\n" +
      "  cost_price_last_month NUMERIC,\n" +
      "  margin_today NUMERIC,\n" +
      "  margin_last_month NUMERIC,\n" +
      "  margin_last_2_months NUMERIC,\n" +
      "  quantity_sold_latest NUMERIC,\n" +
      "  revenue_latest NUMERIC,\n" +
      "  gross_profit_latest NUMERIC,\n" +
      "  gross_profit_last_month NUMERIC,\n" +
      "  market_median_price NUMERIC,\n" +
      "  price_index NUMERIC,\n" +
      "  competitor_gap NUMERIC,\n" +
      "  competitor_count INT64,\n" +
      "  revenue_at_risk NUMERIC,\n" +
      "  margin_leakage NUMERIC,\n" +
      "  opportunity_score NUMERIC,\n" +
      "  risk_score NUMERIC\n" +
      ")"
    );

    // 5. Daily Alerts (precomputed anomaly alerts)
    results.daily_alerts = BigQueryService.executeDDL(
      "CREATE TABLE IF NOT EXISTS `" + dataset + ".daily_alerts` (\n" +
      "  snapshot_date DATE,\n" +
      "  product_sku STRING,\n" +
      "  product_name STRING,\n" +
      "  alert_type STRING,\n" +
      "  details STRING,\n" +
      "  severity STRING,\n" +
      "  revenue_latest NUMERIC,\n" +
      "  created_at TIMESTAMP\n" +
      ")"
    );

    // Log results
    var allSuccess = true;
    for (var table in results) {
      if (!results[table]) {
        Logger.log("SchemaService: FAILED to create table: " + table);
        allSuccess = false;
      }
    }
    if (allSuccess) {
      Logger.log("SchemaService: All tables verified/created successfully.");
    }

    return results;
  }

  /**
   * Ensure the dataset exists. BigQuery Advanced Service doesn't have a 
   * direct dataset create method, so we use a try-catch approach.
   */
  function ensureDatasetExists(datasetId) {
    try {
      var projectId = BigQueryService.getProjectId();
      BigQuery.Datasets.get(projectId, datasetId);
      Logger.log("SchemaService: Dataset '" + datasetId + "' exists.");
    } catch(err) {
      // Dataset doesn't exist — create it
      try {
        var dataset = {
          datasetReference: {
            projectId: BigQueryService.getProjectId(),
            datasetId: datasetId
          },
          location: "US"
        };
        BigQuery.Datasets.insert(dataset, BigQueryService.getProjectId());
        Logger.log("SchemaService: Created dataset '" + datasetId + "'.");
      } catch(createErr) {
        Logger.log("SchemaService: Could not create dataset '" + datasetId + "': " + createErr.toString());
      }
    }
  }

  return {
    ensureTablesExist: ensureTablesExist
  };
})();
