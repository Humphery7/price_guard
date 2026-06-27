/**
 * BigQueryService / Spreadsheet Database Service
 * Abstracts database interactions. Can run in:
 * 1. Mock Mode (default) - uses static memory database.
 * 2. Spreadsheet Mode (Connected Sheets) - reads/writes directly to spreadsheet tabs.
 * 3. BigQuery Mode - queries Google Cloud BigQuery.
 */
var BigQueryService = (function() {
  
  function getDbMode() {
    var props = PropertiesService.getScriptProperties();
    return props.getProperty("DB_MODE") || "spreadsheet"; // "mock", "spreadsheet", or "bigquery"
  }

  function getSpreadsheetId() {
    var props = PropertiesService.getScriptProperties();
    return props.getProperty("SPREADSHEET_DB_ID");
  }

  function getProjectId() {
    var props = PropertiesService.getScriptProperties();
    return props.getProperty("BQ_PROJECT_ID");
  }

  function getDataset() {
    var props = PropertiesService.getScriptProperties();
    return props.getProperty("BQ_DATASET") || "price_guard";
  }

  function getFullTableRef(tableName) {
    return getProjectId() + "." + getDataset() + "." + tableName;
  }

  function useBigQuery() {
    return getDbMode() === "bigquery";
  }

  // ─────────────────────────────────────────────────────────────
  // Core Query Router
  // ─────────────────────────────────────────────────────────────

  /**
   * Main query router. Matches SQL-like select statements to BigQuery, Spreadsheet tabs, or Mock arrays.
   */
  function query(sql) {
    var mode = getDbMode();
    if (mode === "bigquery") {
      return runBigQuery(sql);
    } else if (mode === "spreadsheet") {
      return runSpreadsheetQuery(sql);
    } else {
      return runMockQuery(sql);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // BigQuery: Standard Query (SELECT)
  // ─────────────────────────────────────────────────────────────

  /**
   * Run query on Google Cloud BigQuery. Supports pagination for large result sets.
   */
  function runBigQuery(sql) {
    try {
      var request = { query: sql, useLegacySql: false };
      var queryResults = BigQuery.Jobs.query(request, getProjectId());
      var jobId = queryResults.jobReference.jobId;

      // Poll for completion
      var sleepTimeMs = 500;
      while (!queryResults.jobComplete) {
        Utilities.sleep(sleepTimeMs);
        sleepTimeMs = Math.min(sleepTimeMs * 2, 5000);
        queryResults = BigQuery.Jobs.getQueryResults(getProjectId(), jobId);
      }

      var fields = queryResults.schema.fields.map(function(f) { return f.name; });
      var results = [];
      
      // Process first page of results
      var rows = queryResults.rows || [];
      for (var i = 0; i < rows.length; i++) {
        var rowObj = {};
        for (var j = 0; j < fields.length; j++) {
          rowObj[fields[j]] = rows[i].f[j].v;
        }
        results.push(rowObj);
      }

      // Handle pagination — fetch remaining pages if pageToken is present
      var pageToken = queryResults.pageToken;
      while (pageToken) {
        var nextPage = BigQuery.Jobs.getQueryResults(getProjectId(), jobId, { pageToken: pageToken });
        var nextRows = nextPage.rows || [];
        for (var i = 0; i < nextRows.length; i++) {
          var rowObj = {};
          for (var j = 0; j < fields.length; j++) {
            rowObj[fields[j]] = nextRows[i].f[j].v;
          }
          results.push(rowObj);
        }
        pageToken = nextPage.pageToken;
      }

      return results;
    } catch(err) {
      Logger.log("BigQuery Query failed: " + err.toString() + ". Falling back to mock.");
      return runMockQuery(sql);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // BigQuery: Execute DDL (CREATE TABLE, etc.)
  // ─────────────────────────────────────────────────────────────

  /**
   * Execute a DDL statement (CREATE TABLE IF NOT EXISTS, ALTER TABLE, etc.).
   * Returns true on success, false on failure.
   */
  function executeDDL(sql) {
    if (!useBigQuery()) {
      Logger.log("executeDDL skipped: not in BigQuery mode.");
      return true; // No-op in mock/spreadsheet mode
    }

    try {
      var request = { query: sql, useLegacySql: false };
      var queryResults = BigQuery.Jobs.query(request, getProjectId());
      var jobId = queryResults.jobReference.jobId;

      var sleepTimeMs = 500;
      while (!queryResults.jobComplete) {
        Utilities.sleep(sleepTimeMs);
        sleepTimeMs = Math.min(sleepTimeMs * 2, 5000);
        queryResults = BigQuery.Jobs.getQueryResults(getProjectId(), jobId);
      }

      Logger.log("DDL executed successfully.");
      return true;
    } catch(err) {
      Logger.log("DDL execution failed: " + err.toString());
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // BigQuery: Run Query and Write Results to Destination Table
  // ─────────────────────────────────────────────────────────────

  /**
   * Execute a SELECT query and write results to a destination table.
   * @param {string} sql - The SELECT query to execute.
   * @param {string} destinationTableId - Fully qualified table ID (project.dataset.table).
   * @param {string} writeDisposition - "WRITE_TRUNCATE" (overwrite) or "WRITE_APPEND".
   * @returns {boolean} true on success, false on failure.
   */
  function runQueryToTable(sql, destinationTableId, writeDisposition) {
    if (!useBigQuery()) {
      Logger.log("runQueryToTable skipped: not in BigQuery mode.");
      return true;
    }

    try {
      // Parse the destination table ID into project, dataset, and table components
      var parts = destinationTableId.split(".");
      if (parts.length !== 3) {
        Logger.log("Invalid destination table ID format. Expected: project.dataset.table");
        return false;
      }

      var jobResource = {
        configuration: {
          query: {
            query: sql,
            useLegacySql: false,
            destinationTable: {
              projectId: parts[0],
              datasetId: parts[1],
              tableId: parts[2]
            },
            writeDisposition: writeDisposition || "WRITE_TRUNCATE",
            allowLargeResults: true
          }
        }
      };

      var job = BigQuery.Jobs.insert(jobResource, getProjectId());
      var jobId = job.jobReference.jobId;

      // Poll for job completion
      var sleepTimeMs = 1000;
      var status = BigQuery.Jobs.get(getProjectId(), jobId);
      while (status.status.state !== "DONE") {
        Utilities.sleep(sleepTimeMs);
        sleepTimeMs = Math.min(sleepTimeMs * 2, 10000);
        status = BigQuery.Jobs.get(getProjectId(), jobId);
      }

      // Check for errors
      if (status.status.errorResult) {
        Logger.log("Query-to-table job failed: " + JSON.stringify(status.status.errorResult));
        return false;
      }

      Logger.log("Query-to-table job completed. Destination: " + destinationTableId);
      return true;
    } catch(err) {
      Logger.log("runQueryToTable failed: " + err.toString());
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // BigQuery: Insert Rows Directly
  // ─────────────────────────────────────────────────────────────

  /**
   * Insert rows into a BigQuery table using streaming insert.
   * @param {string} destinationTableId - Fully qualified table ID (project.dataset.table).
   * @param {Array<Object>} rows - Array of row objects to insert.
   * @returns {boolean} true on success, false on failure.
   */
  function insertRows(destinationTableId, rows) {
    if (!useBigQuery()) {
      Logger.log("insertRows skipped: not in BigQuery mode.");
      return true;
    }

    if (!rows || rows.length === 0) {
      Logger.log("insertRows: no rows to insert.");
      return true;
    }

    try {
      var parts = destinationTableId.split(".");
      if (parts.length !== 3) {
        Logger.log("Invalid destination table ID format. Expected: project.dataset.table");
        return false;
      }

      // BigQuery streaming insert has a batch limit of ~500 rows per request
      var BATCH_SIZE = 500;
      for (var batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
        var batch = rows.slice(batchStart, batchStart + BATCH_SIZE);
        var insertAllData = {
          rows: batch.map(function(row, idx) {
            return {
              insertId: String(batchStart + idx),
              json: row
            };
          })
        };

        var response = BigQuery.Tabledata.insertAll(
          insertAllData,
          parts[0],  // projectId
          parts[1],  // datasetId
          parts[2]   // tableId
        );

        if (response.insertErrors && response.insertErrors.length > 0) {
          Logger.log("insertRows encountered errors: " + JSON.stringify(response.insertErrors.slice(0, 3)));
          return false;
        }
      }

      Logger.log("insertRows: successfully inserted " + rows.length + " rows into " + destinationTableId);
      return true;
    } catch(err) {
      Logger.log("insertRows failed: " + err.toString());
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // BigQuery: Execute DML (INSERT/UPDATE/DELETE without results)
  // ─────────────────────────────────────────────────────────────

  /**
   * Execute a DML statement (INSERT INTO, UPDATE, DELETE).
   * These don't return row results but modify data.
   * @param {string} sql - The DML statement.
   * @returns {boolean} true on success, false on failure.
   */
  function executeDML(sql) {
    if (!useBigQuery()) {
      Logger.log("executeDML skipped: not in BigQuery mode.");
      return true;
    }

    try {
      var request = { query: sql, useLegacySql: false };
      var queryResults = BigQuery.Jobs.query(request, getProjectId());
      var jobId = queryResults.jobReference.jobId;

      var sleepTimeMs = 500;
      while (!queryResults.jobComplete) {
        Utilities.sleep(sleepTimeMs);
        sleepTimeMs = Math.min(sleepTimeMs * 2, 5000);
        queryResults = BigQuery.Jobs.getQueryResults(getProjectId(), jobId);
      }

      Logger.log("DML executed successfully. Rows affected: " + (queryResults.numDmlAffectedRows || 0));
      return true;
    } catch(err) {
      Logger.log("DML execution failed: " + err.toString());
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Spreadsheet Mode
  // ─────────────────────────────────────────────────────────────

  /**
   * Runs queries on Google Spreadsheet tabs.
   * Maps "internal_products" to the sheet named "internal_products".
   * Maps "product_matches" to the sheet named "product_matches".
   */
  function runSpreadsheetQuery(sql) {
    var cleaned = sql.toLowerCase().replace(/\s+/g, " ");
    var ssId = getSpreadsheetId();
    if (!ssId) {
      Logger.log("SPREADSHEET_DB_ID property is missing. Running mock fallback.");
      return runMockQuery(sql);
    }

    try {
      var ss = SpreadsheetApp.openById(ssId);
      var sheetName = "";
      
      if (cleaned.indexOf("internal_products") > -1) {
        sheetName = "internal_products";
      } else if (cleaned.indexOf("product_matches") > -1) {
        sheetName = "product_matches";
      } else if (cleaned.indexOf("raw_competitor_products") > -1) {
        sheetName = "raw_competitor_products";
      } else if (cleaned.indexOf("computed_daily_metrics") > -1) {
        sheetName = "computed_daily_metrics";
      } else if (cleaned.indexOf("daily_alerts") > -1) {
        sheetName = "daily_alerts";
      } else {
        return [];
      }

      var sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        Logger.log("Sheet tab '" + sheetName + "' not found. Creating it.");
        sheet = ss.insertSheet(sheetName);
        return [];
      }

      var dataRange = sheet.getDataRange();
      var values = dataRange.getValues();
      if (values.length <= 1) {
        return []; // Only headers or empty
      }

      var headers = values[0];
      var results = [];

      for (var i = 1; i < values.length; i++) {
        var rowObj = {};
        for (var j = 0; j < headers.length; j++) {
          rowObj[headers[j]] = values[i][j];
        }
        results.push(rowObj);
      }
      return results;
    } catch(err) {
      Logger.log("Spreadsheet Query failed: " + err.toString() + ". Falling back to mock.");
      return runMockQuery(sql);
    }
  }

  /**
   * Write or append a row directly into the Google Spreadsheet database.
   */
  function saveSpreadsheetMatch(match) {
    var ssId = getSpreadsheetId();
    if (!ssId) return;

    try {
      var ss = SpreadsheetApp.openById(ssId);
      var sheet = ss.getSheetByName("product_matches");
      if (!sheet) {
        sheet = ss.insertSheet("product_matches");
        sheet.appendRow([
          "product_sku", "competitor", "competitor_product_name", "latest_price",
          "confidence_score", "match_method", "match_explanation", "is_approved", "last_matched_date"
        ]);
      }

      var dataRange = sheet.getDataRange();
      var values = dataRange.getValues();
      var headers = values[0];
      var skuIdx = headers.indexOf("product_sku");
      var compIdx = headers.indexOf("competitor");

      // Check if duplicate matches exists and overwrite, or append
      var foundRow = -1;
      for (var i = 1; i < values.length; i++) {
        if (values[i][skuIdx] == match.product_sku && values[i][compIdx] == match.competitor) {
          foundRow = i + 1; // 1-indexed row number
          break;
        }
      }

      var rowData = headers.map(function(header) {
        return match[header] !== undefined ? match[header] : "";
      });

      if (foundRow > -1) {
        sheet.getRange(foundRow, 1, 1, headers.length).setValues([rowData]);
      } else {
        sheet.appendRow(rowData);
      }
    } catch(err) {
      Logger.log("Failed to save match to spreadsheet: " + err.toString());
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Mock Database Fallback
  // ─────────────────────────────────────────────────────────────

  var mockDb = {
    products: [
      {
        product_sku: "940XRK",
        product_name: "Quaker Whole Oats 900g",
        supplier_name: "Okearin market",
        product_category_level_one: "Packaged Foods",
        product_category_level_two: "Breakfast / Spreads",
        product_category_level_three: "Cereals",
        cost_price_last_2_months: 11250,
        selling_price_last_2_months: 14000,
        quantity_sold_last_2_months: 140,
        revenue_last_2_months: 1960000,
        cost_price_last_month: 11250,
        selling_price_last_month: 14000,
        quantity_sold_last_month: 75,
        revenue_last_month: 1050000,
        cost_price_today: 11250,
        selling_price_today: 14000,
        quantity_sold_latest: 85,
        revenue_latest: 1190000
      },
      {
        product_sku: "4I01EF",
        product_name: "10K Love Box Luxury Floral",
        supplier_name: "Roda (Hamada Ent)",
        product_category_level_one: "Snacks",
        product_category_level_two: "Confectionary",
        product_category_level_three: "Biscuits",
        cost_price_last_2_months: 8000,
        selling_price_last_2_months: 10000,
        quantity_sold_last_2_months: 20,
        revenue_last_2_months: 200000,
        cost_price_last_month: 8000,
        selling_price_last_month: 10000,
        quantity_sold_last_month: 10,
        revenue_last_month: 100000,
        cost_price_today: 8000,
        selling_price_today: 10000,
        quantity_sold_latest: 15,
        revenue_latest: 150000
      },
      {
        product_sku: "Q165ZR",
        product_name: "12 Spices Kilishi 150g",
        supplier_name: "Okearin market",
        product_category_level_one: "Packaged Foods",
        product_category_level_two: "Cooking / Condiments / Baking",
        product_category_level_three: "Salt / Pepper / Seasoning",
        cost_price_last_2_months: 4028,
        selling_price_last_2_months: 5050,
        quantity_sold_last_2_months: 220,
        revenue_last_2_months: 1111000,
        cost_price_last_month: 4028,
        selling_price_last_month: 5050,
        quantity_sold_last_month: 115,
        revenue_last_month: 580750,
        cost_price_today: 4028,
        selling_price_today: 5050,
        quantity_sold_latest: 130,
        revenue_latest: 656500
      },
      {
        product_sku: "BT554W",
        product_name: "12 Spices Kilishi 35g",
        supplier_name: "Okearin market",
        product_category_level_one: "Packaged Foods",
        product_category_level_two: "Cooking / Condiments / Baking",
        product_category_level_three: "Salt / Pepper / Seasoning",
        cost_price_last_2_months: 876,
        selling_price_last_2_months: 1313,
        quantity_sold_last_2_months: 450,
        revenue_last_2_months: 590850,
        cost_price_last_month: 876,
        selling_price_last_month: 1313,
        quantity_sold_last_month: 210,
        revenue_last_month: 275730,
        cost_price_today: 876,
        selling_price_today: 1313,
        quantity_sold_latest: 240,
        revenue_latest: 315120
      },
      {
        product_sku: "570121",
        product_name: "Emborg Red Cheddar Mild 200Gm",
        supplier_name: "Chi Limited",
        product_category_level_one: "Dairy / Chilled / Eggs",
        product_category_level_two: "Dairy / Eggs",
        product_category_level_three: "Cheese",
        cost_price_last_2_months: 9000,
        selling_price_last_2_months: 11500,
        quantity_sold_last_2_months: 80,
        revenue_last_2_months: 920000,
        cost_price_last_month: 9000,
        selling_price_last_month: 11500,
        quantity_sold_last_month: 40,
        revenue_last_month: 460000,
        cost_price_today: 9500,
        selling_price_today: 12500,
        quantity_sold_latest: 50,
        revenue_latest: 625000
      },
      {
        product_sku: "322802",
        product_name: "President Whipping Cream 1Lt",
        supplier_name: "Chi Limited",
        product_category_level_one: "Dairy / Chilled / Eggs",
        product_category_level_two: "Dairy / Eggs",
        product_category_level_three: "Cream",
        cost_price_last_2_months: 18000,
        selling_price_last_2_months: 22000,
        quantity_sold_last_2_months: 60,
        revenue_last_2_months: 1320000,
        cost_price_last_month: 18000,
        selling_price_last_month: 22000,
        quantity_sold_last_month: 25,
        revenue_last_month: 550000,
        cost_price_today: 19500,
        selling_price_today: 21000,
        quantity_sold_latest: 30,
        revenue_latest: 630000
      }
    ],
    
    matches: [
      {
        product_sku: "940XRK",
        competitor: "mano",
        competitor_product_name: "Quaker Oats 900g Pack",
        latest_price: 13800,
        confidence_score: 95.5,
        match_method: "fuzzy_heuristics",
        match_explanation: "Fuzzy text score of 95.5%. Pack weights match perfectly.",
        is_approved: true,
        last_matched_date: "2026-06-24 15:30:00"
      },
      {
        product_sku: "940XRK",
        competitor: "chowstore",
        competitor_product_name: "Quaker Whole Oats 900g",
        latest_price: 13500,
        confidence_score: 100.0,
        match_method: "exact_normalized",
        match_explanation: "Exact normalized name match",
        is_approved: true,
        last_matched_date: "2026-06-24 15:31:00"
      },
      {
        product_sku: "570121",
        competitor: "spar",
        competitor_product_name: "Emborg Red Cheddar Mild 200Gm",
        latest_price: 11800,
        confidence_score: 100.0,
        match_method: "barcode",
        match_explanation: "Exact barcode match: 5701215045354",
        is_approved: true,
        last_matched_date: "2026-06-24 15:35:00"
      },
      {
        product_sku: "322802",
        competitor: "spar",
        competitor_product_name: "President Whipping Cream 1Lt",
        latest_price: 22075,
        confidence_score: 100.0,
        match_method: "barcode",
        match_explanation: "Exact barcode match: 3228020160314",
        is_approved: true,
        last_matched_date: "2026-06-24 15:36:00"
      },
      {
        product_sku: "322802",
        competitor: "chowstore",
        competitor_product_name: "President Whipping Cream 1Lt",
        latest_price: 21500,
        confidence_score: 100.0,
        match_method: "exact_normalized",
        match_explanation: "Exact name matching",
        is_approved: true,
        last_matched_date: "2026-06-24 15:37:00"
      }
    ]
  };

  function runMockQuery(sql) {
    var cleaned = sql.toLowerCase().replace(/\s+/g, " ");
    if (cleaned.indexOf("from purchases") > -1 || cleaned.indexOf("glovo") > -1 || cleaned.indexOf("internal_products") > -1) {
      return mockDb.products;
    }
    if (cleaned.indexOf("product_matches") > -1) {
      return mockDb.matches;
    }
    if (cleaned.indexOf("computed_daily_metrics") > -1) {
      // Return mock computed metrics (same as computing from products/matches)
      return [];
    }
    if (cleaned.indexOf("daily_alerts") > -1) {
      return [];
    }
    return [];
  }

  function getMockProducts() { return mockDb.products; }
  function getMockMatches() { return mockDb.matches; }
  
  function saveMockMatch(match) {
    var found = false;
    for (var i = 0; i < mockDb.matches.length; i++) {
      if (mockDb.matches[i].product_sku === match.product_sku && mockDb.matches[i].competitor === match.competitor) {
        mockDb.matches[i] = match;
        found = true;
        break;
      }
    }
    if (!found) {
      mockDb.matches.push(match);
    }
  }

  return {
    query: query,
    getDbMode: getDbMode,
    useBigQuery: useBigQuery,
    getProjectId: getProjectId,
    getDataset: getDataset,
    getFullTableRef: getFullTableRef,
    getMockProducts: getMockProducts,
    getMockMatches: getMockMatches,
    saveMockMatch: saveMockMatch,
    saveSpreadsheetMatch: saveSpreadsheetMatch,
    // New automation methods
    executeDDL: executeDDL,
    executeDML: executeDML,
    runQueryToTable: runQueryToTable,
    insertRows: insertRows
  };
})();
