Frontend:
Google Apps Script HTML Service
Bootstrap 5
JavaScript

Backend:
Google Apps Script

Database:
BigQuery

Charts:
Chart.js

Matching:
Python + RapidFuzz
(reuse existing Mano and Chowdeck scripts)

Scheduler:
Apps Script Time Triggers
(run daily at 8 AM)

Authentication:
Google Authentication
(Session.getActiveUser())

Notifications:
Email (GmailApp)
Slack Webhooks (optional)

Theme:
Modern dark/light mode

UI Style:
Professional dashboard similar to Stripe/Metabase/Power BI

Responsive:
Desktop-first with tablet support

Architecture:
Daily scheduled jobs compute metrics and save results to BigQuery.
Dashboard reads precomputed results from BigQuery instead of recalculating on page load.

Build the application as a Google Apps Script Web App.

Do not use spreadsheets as the user interface.

Use HTML Service with Bootstrap 5 and Chart.js to create a modern dashboard experience.

Use a modular structure with separate services, pages, and utility files.

The UI should feel like a SaaS dashboard, not a spreadsheet.