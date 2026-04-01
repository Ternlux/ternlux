# DagFlux Documentation

## Overview

DagFlux is an intelligent ETL (Extract, Transform, Load) platform that combines visual workflow orchestration with conversational AI to simplify data integration, transformation, and analysis across multiple data sources. Built for data engineers, analysts, and developers, DagFlux enables you to connect, transform, and move data between databases, cloud storage, and SaaS platforms without writing complex code.

---

## Table of Contents

1. [Core Features](#core-features)
2. [Supported Connectors](#supported-connectors)
3. [Workflow Builder](#workflow-builder)
4. [AI Chatbot Assistant](#ai-chatbot-assistant)
5. [Node Types](#node-types)
6. [Platform Benefits](#platform-benefits)
7. [Integration Channels](#integration-channels)
8. [Use Cases](#use-cases)

---

## Core Features

### Visual Workflow Orchestration
- **Drag-and-drop interface** for building complex data pipelines
- **Real-time execution** with progress tracking and error handling
- **Multi-database operations** - combine data from different sources in a single workflow
- **Schema auto-detection** - automatically infer table structures and data types
- **Version control** - save and manage workflow configurations

### Conversational AI Integration
- **Natural language transformations** - describe what you want in plain English
- **Intelligent query generation** - AI writes optimized SQL/NoSQL queries for you
- **Error recovery** - automatic detection and fixing of transformation errors
- **Context-aware suggestions** - AI understands your data and suggests best practices
- **Workflow generation** - create entire ETL pipelines through conversation
- **Data Q&A** - ask questions about your data and get instant insights

### Cross-Platform Data Movement
- **Database-to-database transfers** - move data between different database types
- **Cloud storage integration** - read from and write to S3, Azure Blob, Google Cloud Storage
- **Local file processing** - work with CSV, JSON, Excel, Parquet, Avro, SQLite, NeDB
- **Streaming capabilities** - handle large datasets with chunked processing
- **Schema translation** - automatic type conversion between different databases

---

## Supported Connectors

### SQL Databases
- **PostgreSQL** - Open-source relational database
- **MySQL** - Popular open-source database
- **Microsoft SQL Server** - Enterprise relational database
- **Amazon Redshift** - Cloud data warehouse
- **Google BigQuery** - Serverless data warehouse
- **Snowflake** - Cloud data platform
- **SQLite** - Lightweight embedded database

### NoSQL Databases
- **MongoDB** - Document database
- **NeDB** - Embedded JavaScript database

### Cloud Storage
- **Amazon S3** - Object storage
- **Azure Blob Storage** - Microsoft cloud storage
- **Google Cloud Storage** - Google cloud object storage

### SaaS & Productivity
- **Google Sheets** - Cloud spreadsheet platform (with automatic import to SQLite)

### MCP Server Integrations (Model Context Protocol)
- **Salesforce** - CRM and customer data platform
- **HubSpot** - Marketing, sales, and service platform
- **Custom MCP servers** - Extensible architecture for additional integrations

### Local Files
- **CSV** - Comma-separated values
- **JSON** - JavaScript Object Notation
- **Excel** - Microsoft spreadsheet files (.xlsx)
- **Parquet** - Columnar storage format
- **Avro** - Row-based storage format

---

## Workflow Builder

### Creating Workflows

Workflows in DagFlux are visual representations of your data pipeline. Each workflow consists of connected nodes that represent data sources, transformations, joins, and outputs.

#### Workflow Components:
1. **Nodes** - Individual operations (Source, Transform, Join, Output)
2. **Edges** - Connections showing data flow between nodes
3. **Configuration Panel** - Interactive chat interface for each node
4. **Execution Engine** - Runs workflows locally with full control

#### Building a Workflow:
1. Add a **Data Source** node and select your connection
2. Connect a **Transformer** node to modify the data
3. Add **Join** nodes to combine multiple sources
4. Connect an **Output** node to save results
5. Execute the workflow and monitor progress

### Workflow Execution
- **Sequential processing** - Nodes execute in dependency order
- **Error handling** - Detailed error messages with suggested fixes
- **Progress tracking** - Real-time status updates for each node
- **Result preview** - View sample data at each step
- **Cancellation support** - Stop workflows mid-execution

---

## AI Chatbot Assistant

### Conversational Workflow Management

The DagFlux chatbot is an intelligent assistant that understands your data, workflows, and intentions. It can create, modify, and explain complex data operations through natural conversation.

#### Core Capabilities:

**1. Workflow Creation**
- "Create a workflow that pulls customer data from PostgreSQL and loads it to BigQuery"
- "Build a pipeline that combines sales data from MySQL with customer data from Salesforce"
- "Set up a daily sync from Google Sheets to our data warehouse"

**2. Data Transformation**
- "Filter this table to only include orders from the last 30 days"
- "Calculate the total revenue by customer and add it as a new column"
- "Convert all date fields to ISO format and remove duplicate records"

**3. Data Analysis & Q&A**
- "What's the average order value in my sales table?"
- "Show me the top 10 customers by revenue"
- "Are there any NULL values in the email column?"
- "What's the distribution of users by country?"

**4. Troubleshooting & Optimization**
- "Why is this transformation failing?"
- "How can I make this join faster?"
- "What's the best way to deduplicate this dataset?"
- "Optimize this query for BigQuery"

**5. Schema & Metadata Exploration**
- "What columns are in the customers table?"
- "Show me sample data from the orders table"
- "What's the data type of the created_at column?"
- "Which tables contain customer email addresses?"

#### Natural Language Features:

**Intent Recognition**
- Understands context from previous messages
- Recognizes ambiguous requests and asks clarifying questions
- Adapts to your terminology and naming conventions

**Smart Defaults**
- Automatically infers storage locations (local vs database)
- Selects appropriate data types for new columns
- Suggests table names and schemas based on context

**Multi-turn Conversations**
- Remembers workflow context throughout the session
- Refines transformations based on feedback
- Iteratively improves queries until they work correctly

**Error Recovery**
- Automatically detects SQL/query errors
- Explains what went wrong in plain language
- Generates fixes and re-executes automatically

---

## Node Types

### 1. Data Source Node

**Purpose:** Connect to databases, files, or APIs to extract data.

**Features:**
- **Connection Management** - Securely store credentials
- **Table/Collection Selection** - Browse available tables
- **Schema Detection** - Automatic column and type inference
- **Preview Data** - View sample rows before processing
- **Query Customization** - Write custom SQL/NoSQL queries

**Supported Operations:**
- Select specific tables/collections
- Define custom queries (SQL or NoSQL)
- Apply filters and limits
- Choose specific columns/fields

**Example Use Cases:**
- Pull customer data from PostgreSQL
- Import sales records from Google Sheets
- Read JSON files from S3
- Query MongoDB collections

---

### 2. Transformer Node

**Purpose:** Modify, clean, filter, and enrich data using AI-powered transformations.

**Features:**
- **Natural Language Transformations** - Describe changes in plain English
- **Operation Modes:**
  - **New Table** - Create a new transformed dataset
  - **In-Place** - Modify the source table directly (UPDATE/DELETE/ALTER)
- **Storage Locations:**
  - **Database** - Store results in the source database
  - **Local** - Save results to local SQLite for further processing
- **AI-Generated SQL/NoSQL** - Automatically writes optimized queries
- **Type Inference** - Automatically detects and converts data types
- **Error Recovery** - AI fixes broken transformations automatically

**Supported Operations:**

**Filtering & Selection:**
- "Keep only active customers"
- "Remove duplicate records"
- "Filter orders from the last 30 days"

**Calculations & Aggregations:**
- "Calculate total revenue per customer"
- "Add a column for customer age based on birthdate"
- "Compute average order value by region"

**Data Cleaning:**
- "Remove rows with NULL email addresses"
- "Trim whitespace from all text fields"
- "Convert all dates to ISO 8601 format"

**Schema Changes:**
- "Add a 'full_name' column combining first and last names"
- "Rename 'customer_id' to 'user_id'"
- "Change status_code from INT to STRING"

**String Operations:**
- "Extract domain from email addresses"
- "Convert all names to title case"
- "Replace 'N/A' with NULL"

**Example Transformations:**
```
User: "Filter to only customers who placed orders in the last 6 months"
AI: Generates: DELETE FROM customers WHERE last_order_date < DATE_SUB(NOW(), INTERVAL 6 MONTH)

User: "Add a column showing customer lifetime value"
AI: Generates: ALTER TABLE customers ADD COLUMN lifetime_value DECIMAL(10,2);
             UPDATE customers SET lifetime_value = (
               SELECT SUM(total) FROM orders WHERE orders.customer_id = customers.id
             )
```

---

### 3. Join Node

**Purpose:** Combine data from multiple sources using SQL-style joins.

**Features:**
- **Cross-Database Joins** - Join tables from different database types
- **Multiple Join Types:**
  - INNER JOIN
  - LEFT JOIN
  - RIGHT JOIN
  - FULL OUTER JOIN
  - CROSS JOIN
- **AI-Generated Join Logic** - Describe the join, AI writes the SQL
- **Column Selection** - Choose specific columns from each source
- **Performance Optimization:**
  - Chunked data loading for large datasets
  - Temporary table creation for complex joins
  - Database-specific pagination (LIMIT/OFFSET vs FETCH NEXT)
- **Execution Modes:**
  - **Database Join** - Execute join in target database
  - **Local SQLite Join** - Perform join locally for cross-database operations

**Join Workflow:**
1. Connect multiple source nodes to the Join node
2. Describe the join relationship in natural language
3. AI generates the join SQL and shows a preview
4. Select target storage location (database or local)
5. Execute and review results

**Example Joins:**
```
User: "Join customers with their orders using customer_id"
AI: Generates:
    SELECT c.*, o.order_id, o.total, o.order_date
    FROM customers c
    INNER JOIN orders o ON c.customer_id = o.customer_id

User: "Left join sales data with product details, include all sales even without product info"
AI: Generates:
    SELECT s.*, p.product_name, p.category
    FROM sales s
    LEFT JOIN products p ON s.product_id = p.id
```

**Cross-Database Example:**
- Join customer data from PostgreSQL with order data from MySQL
- Combine sales from BigQuery with inventory from MongoDB
- Merge Google Sheets data with Salesforce CRM records

---

### 4. Output Node

**Purpose:** Export or load transformed data to destinations.

**Features:**
- **Multiple Output Types:**
  - **Database Connection** - Insert into SQL/NoSQL databases
  - **Local Files** - Export to CSV, JSON, Excel, Parquet, Avro, SQLite, NeDB
  - **Cloud Storage** - Upload to S3, Azure Blob, Google Cloud Storage
- **Auto Schema Creation** - Automatically creates tables with correct types
- **Type Inference** - Detects column types from data:
  - Dates vs Timestamps
  - Integers vs Floats
  - Strings vs Text
  - Booleans
- **Batch Processing** - Chunks large datasets for efficient insertion
- **Database-Specific Optimization:**
  - BigQuery: Streaming inserts with error handling
  - Redshift: COPY command for bulk loads
  - PostgreSQL: Batch inserts with transactions
  - MS SQL: Bulk insert with proper type handling

**Supported Formats:**

**SQL Databases:**
- Automatic CREATE TABLE generation
- Type mapping for each database (e.g., STRING for BigQuery, VARCHAR for PostgreSQL)
- Schema qualification (dataset.table for BigQuery, schema.table for PostgreSQL)
- Quoted identifiers for reserved words

**Local Files:**
- **CSV** - Comma-separated, UTF-8 encoded
- **JSON** - Pretty-printed or compact
- **Excel** - .xlsx format with headers
- **Parquet** - Columnar format for analytics
- **Avro** - Schema-embedded format
- **SQLite** - Embedded database file
- **NeDB** - JavaScript embedded database

**Cloud Storage:**
- **S3** - Upload with bucket/key specification
- **Azure Blob** - Container and blob path
- **GCS** - Bucket and object name

**Example Outputs:**
```
"Save this to BigQuery in dataset.customers_transformed"
"Export to CSV at /data/output/customers.csv"
"Load into PostgreSQL table staging.orders"
"Upload to S3 bucket my-data/exports/daily-report.json"
```

---

## Platform Benefits

### 1. **Unified Data Access**
- Connect to all your data sources from a single interface
- No need to switch between database clients, cloud consoles, or file managers
- Consistent experience across SQL, NoSQL, cloud storage, and SaaS platforms

### 2. **AI-Powered Productivity**
- **10x faster transformations** - Natural language replaces complex SQL
- **Zero SQL knowledge required** - AI writes optimized queries for you
- **Automatic error recovery** - AI detects and fixes issues automatically
- **Smart suggestions** - Context-aware recommendations based on your data

### 3. **Cross-Database Operations**
- **Join data across platforms** - Combine PostgreSQL with MongoDB, BigQuery with MySQL
- **Type-safe conversions** - Automatic type mapping between databases
- **Optimized execution** - Chunked processing for large datasets
- **Database-specific features** - Uses native syntax (LIMIT vs FETCH NEXT, DATE vs TIMESTAMP)

### 4. **Flexibility & Control**
- **Local or Cloud Execution** - Process data locally in SQLite or directly in databases
- **In-Place or New Table** - Choose to modify source data or create new datasets
- **Manual Override** - Review and edit AI-generated queries before execution
- **Custom Connections** - Bring your own credentials and configurations

### 5. **Developer-Friendly**
- **Visual workflow designer** - No code required for common operations
- **Full SQL/NoSQL access** - Power users can write custom queries
- **Extensible architecture** - MCP servers for custom integrations
- **Export workflows** - Save configurations as JSON for version control

### 6. **Enterprise Ready**
- **Secure credential storage** - Encrypted connection credentials
- **Audit logs** - Track all data operations and transformations
- **Error handling** - Comprehensive error messages with troubleshooting guidance
- **Scalable** - Handle datasets from thousands to millions of rows

### 7. **Cost Optimization**
- **Reduce data warehouse costs** - Filter and transform before loading
- **Minimize data transfer** - Select only needed columns
- **Local processing** - Process data locally to avoid cloud compute charges
- **Efficient joins** - Optimized algorithms for cross-database operations

---

## Integration Channels

### Slack Integration

Execute workflows and query data directly from Slack without leaving your conversation.

**Commands:**
- `/dagflux run <workflow_name>` - Execute a saved workflow
- `/dagflux query <question>` - Ask questions about your data
- `/dagflux status <workflow_id>` - Check workflow execution status
- `/dagflux create <description>` - Create a new workflow from description
- `/dagflux preview <table_name>` - View sample data from a table

**Notifications:**
- Workflow completion alerts
- Error notifications with suggested fixes
- Scheduled workflow reports
- Data quality alerts

**Example Interactions:**
```
User: /dagflux query "What were the top 5 products by revenue last month?"
DagFlux: 📊 Top 5 Products by Revenue (Last Month):
1. Product A - $45,230
2. Product B - $38,940
...

User: /dagflux run daily_sales_sync
DagFlux: ✅ Workflow 'daily_sales_sync' started.
Processing 12,450 rows from PostgreSQL to BigQuery...
[Progress: 100%] Completed in 23 seconds.
```

### Discord Integration

Interact with DagFlux from Discord servers for team collaboration.

**Commands:**
- `!dagflux run <workflow>` - Execute workflows
- `!dagflux ask <question>` - Data Q&A
- `!dagflux create <description>` - Generate workflows
- `!dagflux help` - List available commands

**Features:**
- Role-based permissions
- Channel-specific workflows
- Embedded result visualizations
- Thread-based conversations for complex operations

---

## Use Cases

### Data Migration
**Scenario:** Migrate customer data from MySQL to BigQuery

**Workflow:**
1. **Data Source** - Connect to MySQL, select `customers` table
2. **Transformer** - "Clean email addresses and remove test accounts"
3. **Output** - Load to BigQuery `production.customers`

**Benefits:** Type-safe migration, automatic schema creation, incremental updates

---

### Data Enrichment
**Scenario:** Combine CRM data with sales analytics

**Workflow:**
1. **Data Source A** - Salesforce customer records (via MCP)
2. **Data Source B** - Stripe transaction data (via API)
3. **Join** - "Join customers with their transaction history"
4. **Transformer** - "Calculate customer lifetime value and segment into tiers"
5. **Output** - Save to PostgreSQL `analytics.customer_insights`

**Benefits:** Cross-platform integration, AI-powered calculations, automated segmentation

---

### Reporting Automation
**Scenario:** Daily sales report combining multiple sources

**Workflow:**
1. **Data Source A** - Yesterday's orders from PostgreSQL
2. **Data Source B** - Product catalog from MongoDB
3. **Join** - "Match orders with product details"
4. **Transformer** - "Aggregate by product category and calculate totals"
5. **Output** - Export to Excel and upload to Google Drive

**Chatbot Trigger:**
```
User: "Create a daily workflow that emails me a sales report every morning at 8am"
DagFlux: ✅ Workflow created. Report will include:
- Total orders by category
- Revenue breakdown
- Top 10 products
Schedule: Daily at 8:00 AM
```

---

### Data Quality Monitoring
**Scenario:** Detect and fix data quality issues

**Chatbot Interaction:**
```
User: "Check the customers table for any data quality issues"
DagFlux: 🔍 Analysis complete. Found 3 issues:
1. 45 rows with NULL email addresses
2. 12 duplicate phone numbers
3. 8 invalid date formats in created_at

Would you like me to create a cleanup workflow?

User: "Yes, create a workflow to fix these issues"
DagFlux: ✅ Created cleanup workflow:
- Remove rows with NULL emails
- Deduplicate by phone number (keep most recent)
- Convert dates to ISO 8601 format
Ready to execute?
```

---

### Cross-Database Analytics
**Scenario:** Combine data warehouse with operational databases

**Workflow:**
1. **Data Source A** - BigQuery analytics (aggregate metrics)
2. **Data Source B** - PostgreSQL (real-time transactions)
3. **Join** - Local SQLite join for cross-platform operation
4. **Transformer** - "Calculate variance between forecasted and actual revenue"
5. **Output** - Load to Redshift for BI tool consumption

**Benefits:** Real-time + historical analysis, cross-platform joins, optimized for BI tools

---

## Getting Started

### 1. Set Up Connections
- Navigate to **Connections** tab
- Add your database credentials
- Test connections to ensure connectivity

### 2. Create Your First Workflow
- Click **New Workflow**
- Add a Data Source node
- Select your connection and table
- Add a Transformer node
- Describe your transformation in plain English
- Add an Output node
- Execute and view results

### 3. Use the Chatbot
- Ask questions about your data
- Request workflow creation
- Get help with transformations
- Troubleshoot errors

### 4. Integrate with Team Tools
- Connect DagFlux to Slack or Discord
- Share workflows with your team
- Set up scheduled executions
- Receive notifications for critical workflows

---

## Future Roadmap

- **Advanced ML Features** - Anomaly detection, forecasting, and predictive analytics
- **Version Control Integration** - Git-based workflow management
- **Collaborative Workflows** - Real-time multi-user editing
- **Custom Connectors** - SDK for building your own data source plugins
- **Streaming Data** - Real-time data pipeline support
- **Advanced Scheduling** - Cron-based workflow automation
- **Data Lineage Tracking** - Visualize data flow across workflows
- **Performance Profiling** - Identify and optimize slow transformations

---

## Support & Resources

- **Documentation:** [docs.dagflux.io](https://docs.dagflux.io)
- **Community Forum:** [community.dagflux.io](https://community.dagflux.io)
- **GitHub Issues:** [github.com/dagflux/dagflux/issues](https://github.com/dagflux/dagflux/issues)
- **Email Support:** support@dagflux.io

---

**DagFlux** - Making data integration intelligent, conversational, and effortless.
