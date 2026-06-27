/**
 * DataIngestionService
 * Handles automated data ingestion for the daily pipeline.
 * 
 * Responsibilities:
 * 1. Refresh internal catalog from Glovo BigQuery tables (glovo.sql)
 * 2. Ingest SPAR & SuperSaver partner data from Connected Sheets via SQL
 * 3. Dispatch GitHub Actions to run Mano/Chowdeck scrapers
 */
var DataIngestionService = (function() {

  // ─────────────────────────────────────────────────────────────
  // SQL Queries (embedded from project SQL files)
  // ─────────────────────────────────────────────────────────────

  /**
   * The Glovo internal catalog query.
   * Source: candidate/glovo.sql
   * This query dynamically computes date ranges using CURRENT_DATE()
   * so it always returns fresh data.
   */
  var GLOVO_CATALOG_SQL = [
    "WITH date_ranges AS (",
    "  SELECT",
    "    DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 2 MONTH), MONTH) AS last_2_month_start,",
    "    DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), MONTH) AS last_month_start,",
    "    DATE_TRUNC(CURRENT_DATE(), MONTH) AS current_month_start,",
    "    CURRENT_DATE() AS today",
    "),",
    "",
    "sales AS (",
    "  SELECT",
    "    s.product_sku,",
    "    MAX(s.product_name_local) AS product_name,",
    "    MAX(s.product_category_level_one) AS product_category_level_one,",
    "    MAX(s.product_category_level_two) AS product_category_level_two,",
    "    MAX(s.product_category_level_three) AS product_category_level_three,",
    "",
    "    ARRAY_AGG(",
    "      CASE",
    "        WHEN DATE(s.p_order_activation_local_date) >= dr.last_2_month_start",
    "         AND DATE(s.p_order_activation_local_date) < dr.current_month_start",
    "        THEN s.product_unit_price_local_currency",
    "      END",
    "      IGNORE NULLS",
    "      ORDER BY s.p_order_activation_local_date DESC",
    "      LIMIT 1",
    "    )[SAFE_OFFSET(0)] AS selling_price_last_2_months,",
    "",
    "    COALESCE(SUM(",
    "      CASE",
    "        WHEN DATE(s.p_order_activation_local_date) >= dr.last_2_month_start",
    "         AND DATE(s.p_order_activation_local_date) < dr.current_month_start",
    "        THEN s.product_quantity_delivered",
    "      END",
    "    ), 0) AS quantity_sold_last_2_months,",
    "",
    "    COALESCE(SUM(",
    "      CASE",
    "        WHEN DATE(s.p_order_activation_local_date) >= dr.last_2_month_start",
    "         AND DATE(s.p_order_activation_local_date) < dr.current_month_start",
    "        THEN s.product_total_revenue_local_currency",
    "      END",
    "    ), 0) AS revenue_last_2_months,",
    "",
    "    ARRAY_AGG(",
    "      CASE",
    "        WHEN DATE(s.p_order_activation_local_date) >= dr.last_month_start",
    "         AND DATE(s.p_order_activation_local_date) < dr.current_month_start",
    "        THEN s.product_unit_price_local_currency",
    "      END",
    "      IGNORE NULLS",
    "      ORDER BY s.p_order_activation_local_date DESC",
    "      LIMIT 1",
    "    )[SAFE_OFFSET(0)] AS selling_price_last_month,",
    "",
    "    COALESCE(SUM(",
    "      CASE",
    "        WHEN DATE(s.p_order_activation_local_date) >= dr.last_month_start",
    "         AND DATE(s.p_order_activation_local_date) < dr.current_month_start",
    "        THEN s.product_quantity_delivered",
    "      END",
    "    ), 0) AS quantity_sold_last_month,",
    "",
    "    COALESCE(SUM(",
    "      CASE",
    "        WHEN DATE(s.p_order_activation_local_date) >= dr.last_month_start",
    "         AND DATE(s.p_order_activation_local_date) < dr.current_month_start",
    "        THEN s.product_total_revenue_local_currency",
    "      END",
    "    ), 0) AS revenue_last_month,",
    "",
    "    ARRAY_AGG(",
    "      s.product_unit_price_local_currency",
    "      ORDER BY s.p_order_activation_local_date DESC",
    "      LIMIT 1",
    "    )[SAFE_OFFSET(0)] AS selling_price_today,",
    "",
    "    COALESCE(SUM(",
    "      CASE",
    "        WHEN DATE(s.p_order_activation_local_date) >= dr.last_month_start",
    "         AND DATE(s.p_order_activation_local_date) <= dr.today",
    "        THEN s.product_quantity_delivered",
    "      END",
    "    ), 0) AS quantity_sold_latest,",
    "",
    "    COALESCE(SUM(",
    "      CASE",
    "        WHEN DATE(s.p_order_activation_local_date) >= dr.last_month_start",
    "         AND DATE(s.p_order_activation_local_date) <= dr.today",
    "        THEN s.product_total_revenue_local_currency",
    "      END",
    "    ), 0) AS revenue_latest",
    "",
    "  FROM `fulfillment-dwh-production.curated_data_shared_glovo.mfc_sales__products_sold` s",
    "  CROSS JOIN date_ranges dr",
    "  WHERE s.country_code = 'NG'",
    "    AND s.order_final_status = 'DeliveredStatus'",
    "  GROUP BY 1",
    "),",
    "",
    "purchases AS (",
    "  SELECT",
    "    p.product_sku,",
    "    MAX(p.product_name_local) AS product_name,",
    "    MAX(p.supplier_name) AS supplier_name,",
    "    MAX(p.product_category_level_one) AS product_category_level_one,",
    "    MAX(p.product_category_level_two) AS product_category_level_two,",
    "    MAX(p.product_category_level_three) AS product_category_level_three,",
    "",
    "    ARRAY_AGG(",
    "      CASE",
    "        WHEN DATE(p.purchase_order_created_local_datetime) >= dr.last_2_month_start",
    "         AND DATE(p.purchase_order_created_local_datetime) < dr.current_month_start",
    "        THEN p.product_unit_cost_local_currency",
    "      END",
    "      IGNORE NULLS",
    "      ORDER BY p.purchase_order_created_local_datetime DESC",
    "      LIMIT 1",
    "    )[SAFE_OFFSET(0)] AS cost_price_last_2_months,",
    "",
    "    ARRAY_AGG(",
    "      CASE",
    "        WHEN DATE(p.purchase_order_created_local_datetime) >= dr.last_month_start",
    "         AND DATE(p.purchase_order_created_local_datetime) < dr.current_month_start",
    "        THEN p.product_unit_cost_local_currency",
    "      END",
    "      IGNORE NULLS",
    "      ORDER BY p.purchase_order_created_local_datetime DESC",
    "      LIMIT 1",
    "    )[SAFE_OFFSET(0)] AS cost_price_last_month,",
    "",
    "    ARRAY_AGG(",
    "      p.product_unit_cost_local_currency",
    "      ORDER BY p.purchase_order_created_local_datetime DESC",
    "      LIMIT 1",
    "    )[SAFE_OFFSET(0)] AS cost_price_today",
    "",
    "  FROM `fulfillment-dwh-production.curated_data_shared_glovo.mfc_products_purchased__products_purchased` p",
    "  CROSS JOIN date_ranges dr",
    "  WHERE p.country_code = 'NG'",
    "  GROUP BY 1",
    ")",
    "",
    "SELECT",
    "  COALESCE(p.product_sku, s.product_sku) AS product_sku,",
    "  COALESCE(p.product_name, s.product_name) AS product_name,",
    "  p.supplier_name,",
    "",
    "  COALESCE(p.product_category_level_one, s.product_category_level_one) AS product_category_level_one,",
    "  COALESCE(p.product_category_level_two, s.product_category_level_two) AS product_category_level_two,",
    "  COALESCE(p.product_category_level_three, s.product_category_level_three) AS product_category_level_three,",
    "",
    "  p.cost_price_last_2_months,",
    "  s.selling_price_last_2_months,",
    "  s.quantity_sold_last_2_months,",
    "  s.revenue_last_2_months,",
    "",
    "  p.cost_price_last_month,",
    "  s.selling_price_last_month,",
    "  s.quantity_sold_last_month,",
    "  s.revenue_last_month,",
    "",
    "  p.cost_price_today,",
    "  s.selling_price_today,",
    "  s.quantity_sold_latest,",
    "  s.revenue_latest",
    "",
    "FROM purchases p",
    "FULL OUTER JOIN sales s",
    "  ON p.product_sku = s.product_sku",
    "",
    "ORDER BY product_name"
  ].join("\n");

  /**
   * SPAR partner ingestion query.
   * Source: competitors/queries/spar.sql
   * Reads from Connected Sheets external table and inserts into raw_competitor_products.
   */
  var SPAR_INGESTION_SQL = [
    "INSERT INTO `{DATASET}.raw_competitor_products` (",
    "  competitor,",
    "  product_name,",
    "  latest_price,",
    "  source_type,",
    "  attributes,",
    "  collected_at",
    ")",
    "SELECT",
    "  'spar' AS competitor,",
    "  TRIM(Product_Name) AS product_name,",
    "  SAFE_CAST(REPLACE(REPLACE(CAST(latest_price AS STRING), '₦', ''), ',', '') AS NUMERIC) AS latest_price,",
    "  'partner' AS source_type,",
    "  TO_JSON_STRING(STRUCT(",
    "    product_barcode AS barcode,",
    "    product_category_level_one AS category_level_one,",
    "    product_category_level_two AS category_level_two,",
    "    product_category_level_three AS category_level_three,",
    "    store_name AS store_location",
    "  )) AS attributes,",
    "  CURRENT_TIMESTAMP() AS collected_at",
    "FROM `{EXTERNAL_DATASET}.spar_raw`",
    "WHERE Product_Name IS NOT NULL",
    "  AND latest_price IS NOT NULL"
  ].join("\n");

  /**
   * SuperSaver partner ingestion query.
   * Source: competitors/queries/supersaver.sql
   */
  var SUPERSAVER_INGESTION_SQL = [
    "INSERT INTO `{DATASET}.raw_competitor_products` (",
    "  competitor,",
    "  product_name,",
    "  latest_price,",
    "  source_type,",
    "  attributes,",
    "  collected_at",
    ")",
    "SELECT",
    "  'supersaver' AS competitor,",
    "  TRIM(Product_Name) AS product_name,",
    "  SAFE_CAST(REPLACE(REPLACE(CAST(latest_price AS STRING), '₦', ''), ',', '') AS NUMERIC) AS latest_price,",
    "  'partner' AS source_type,",
    "  TO_JSON_STRING(STRUCT(",
    "    product_barcode AS barcode,",
    "    product_category_level_one AS category_level_one,",
    "    product_category_level_two AS category_level_two,",
    "    product_category_level_three AS category_level_three,",
    "    store_name AS store_location",
    "  )) AS attributes,",
    "  CURRENT_TIMESTAMP() AS collected_at",
    "FROM `{EXTERNAL_DATASET}.supersaver_raw`",
    "WHERE Product_Name IS NOT NULL",
    "  AND latest_price IS NOT NULL"
  ].join("\n");

  // ─────────────────────────────────────────────────────────────
  // Helper: Resolve SQL Placeholders
  // ─────────────────────────────────────────────────────────────

  function resolveSQL(template) {
    var props = PropertiesService.getScriptProperties();
    var dataset = BigQueryService.getDataset();
    var externalDataset = props.getProperty("BQ_EXTERNAL_DATASET") || "external_competitor_data";

    return template
      .replace(/\{DATASET\}/g, dataset)
      .replace(/\{EXTERNAL_DATASET\}/g, externalDataset);
  }

  // ─────────────────────────────────────────────────────────────
  // Step 1: Refresh Internal Catalog (Glovo)
  // ─────────────────────────────────────────────────────────────

  /**
   * Execute the Glovo SQL query and write results to internal_products table.
   * Uses WRITE_TRUNCATE to replace the entire table with fresh data.
   * @returns {Object} { success: boolean, message: string }
   */
  function refreshInternalCatalog() {
    Logger.log("DataIngestionService: Refreshing internal catalog...");

    if (!BigQueryService.useBigQuery()) {
      Logger.log("DataIngestionService: Not in BigQuery mode. Using mock data.");
      return { success: true, message: "Mock mode — skipped catalog refresh." };
    }

    try {
      var destTable = BigQueryService.getFullTableRef("internal_products");
      var success = BigQueryService.runQueryToTable(
        GLOVO_CATALOG_SQL,
        destTable,
        "WRITE_TRUNCATE"
      );

      if (success) {
        Logger.log("DataIngestionService: Internal catalog refreshed successfully.");
        return { success: true, message: "Internal catalog refreshed from Glovo DWH." };
      } else {
        Logger.log("DataIngestionService: Internal catalog refresh failed.");
        return { success: false, message: "Failed to refresh internal catalog." };
      }
    } catch(err) {
      Logger.log("DataIngestionService: Catalog refresh error: " + err.toString());
      return { success: false, message: "Error: " + err.toString() };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Step 2: Ingest Partner Competitors (SPAR & SuperSaver)
  // ─────────────────────────────────────────────────────────────

  /**
   * Clear stale partner data and re-ingest from Connected Sheets external tables.
   * @returns {Object} { success: boolean, results: { spar: boolean, supersaver: boolean } }
   */
  function ingestPartnerCompetitors() {
    Logger.log("DataIngestionService: Ingesting partner competitor data...");

    if (!BigQueryService.useBigQuery()) {
      Logger.log("DataIngestionService: Not in BigQuery mode. Using mock data.");
      return { success: true, message: "Mock mode — skipped partner ingestion." };
    }

    var results = { spar: false, supersaver: false };

    try {
      // Clear stale partner data before reinserting fresh data
      var dataset = BigQueryService.getDataset();
      BigQueryService.executeDML(
        "DELETE FROM `" + dataset + ".raw_competitor_products` WHERE source_type = 'partner'"
      );
      Logger.log("DataIngestionService: Cleared stale partner data.");

      // Ingest SPAR
      var sparSQL = resolveSQL(SPAR_INGESTION_SQL);
      results.spar = BigQueryService.executeDML(sparSQL);
      Logger.log("DataIngestionService: SPAR ingestion " + (results.spar ? "succeeded" : "failed") + ".");

      // Ingest SuperSaver
      var superSaverSQL = resolveSQL(SUPERSAVER_INGESTION_SQL);
      results.supersaver = BigQueryService.executeDML(superSaverSQL);
      Logger.log("DataIngestionService: SuperSaver ingestion " + (results.supersaver ? "succeeded" : "failed") + ".");

      return {
        success: results.spar && results.supersaver,
        results: results,
        message: "Partner ingestion completed. SPAR: " + results.spar + ", SuperSaver: " + results.supersaver
      };
    } catch(err) {
      Logger.log("DataIngestionService: Partner ingestion error: " + err.toString());
      return { success: false, results: results, message: "Error: " + err.toString() };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Step 3: Trigger Scraper Pipeline (Mano & Chowdeck)
  // ─────────────────────────────────────────────────────────────

  /**
   * Dispatch GitHub Actions workflow to run Python scrapers for Mano and Chowdeck.
   * The workflow will:
   * 1. Run mano_scraper.py → output mano_products.csv
   * 2. Run chowstore_scraper.py → output chowstore.csv
   * 3. Run upload_scraped_data.py → upload CSVs to BigQuery
   * @returns {Object} { success: boolean, message: string }
   */
  function triggerScraperPipeline() {
    Logger.log("DataIngestionService: Triggering scraper pipeline...");

    var settings = SettingsService.getSettings();

    if (!settings.github.pat || !settings.github.repo) {
      Logger.log("DataIngestionService: GitHub Actions not configured. Scraper dispatch skipped.");
      return {
        success: false,
        message: "GitHub PAT or repo not configured in Settings. Scraper pipeline skipped."
      };
    }

    try {
      var url = "https://api.github.com/repos/" + settings.github.repo + "/dispatches";
      var headers = {
        "Authorization": "token " + settings.github.pat,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "PriceGuard-GAS-App"
      };
      var payload = {
        event_type: "run_scrapers",
        client_payload: {
          trigger_source: "daily_pipeline",
          timestamp: new Date().toISOString()
        }
      };

      var response = UrlFetchApp.fetch(url, {
        method: "post",
        headers: headers,
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      var code = response.getResponseCode();
      if (code === 204 || code === 200 || code === 201) {
        Logger.log("DataIngestionService: Scraper pipeline dispatched successfully.");
        return { success: true, message: "Scraper pipeline dispatched to GitHub Actions." };
      } else {
        var body = response.getContentText();
        Logger.log("DataIngestionService: GitHub API returned " + code + ": " + body);
        return { success: false, message: "GitHub API returned code " + code + ": " + body };
      }
    } catch(err) {
      Logger.log("DataIngestionService: Scraper dispatch failed: " + err.toString());
      return { success: false, message: "Dispatch error: " + err.toString() };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Full Ingestion Pipeline
  // ─────────────────────────────────────────────────────────────

  /**
   * Run the complete data ingestion pipeline.
   * @returns {Object} Combined status of all ingestion steps.
   */
  function runFullIngestion() {
    var report = {
      catalog: null,
      partners: null,
      scrapers: null,
      timestamp: new Date().toISOString()
    };

    report.catalog = refreshInternalCatalog();
    report.partners = ingestPartnerCompetitors();
    report.scrapers = triggerScraperPipeline();

    var allSuccess = report.catalog.success && report.partners.success;
    // Scraper dispatch is best-effort (async) — don't fail the pipeline if it fails
    report.overall_success = allSuccess;

    Logger.log("DataIngestionService: Full ingestion pipeline completed. Success: " + allSuccess);
    return report;
  }

  return {
    refreshInternalCatalog: refreshInternalCatalog,
    ingestPartnerCompetitors: ingestPartnerCompetitors,
    triggerScraperPipeline: triggerScraperPipeline,
    runFullIngestion: runFullIngestion
  };
})();
