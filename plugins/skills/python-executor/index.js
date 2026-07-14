/**
 * Python Executor Skill Plugin for Ternlux
 * Allows executing Python code directly on the local machine for transformations
 */

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

module.exports = {
  type: 'skill',
  id: 'python-executor',
  name: 'Python Executor',
  icon: './icon.svg',
  category: 'transformer', // Can be 'transformer', 'join', or 'both'
  supportsInteraction: true, // This skill can ask follow-up questions

  /**
   * Get skill description for AI context
   */
  getDescription: () => {
    return {
      name: 'Python Executor',
      description: 'Execute Python code directly on the local machine. Use this when the transformation requires complex data manipulation, scientific computing, or when Python libraries (pandas, numpy, etc.) would be beneficial. The Python code receives input data and must return transformed data.',
      capabilities: [
        'Execute arbitrary Python code',
        'Access to pandas, numpy, and other Python libraries',
        'Complex data transformations',
        'Statistical analysis',
        'Machine learning operations',
        'Custom business logic'
      ],
      inputFormat: 'Array of objects or single object',
      outputFormat: 'Array of objects or single object',
      executionEnvironment: 'local'
    };
  },

  /**
   * Main function to handle all Python skill interactions
   * Returns a prompt for the AI to process
   * @param {Object} params - Request parameters
   * @param {String} params.userRequest - Current user request
   * @param {Array} params.chatHistory - Conversation history
   * @param {Object} params.sourceTableSchema - Source data schema
   * @param {String} params.operationType - 'sql' or 'nosql'
   * @param {Object} params.settings - Current transformation settings
   * @param {Object} params.currentState - Current skill state (pythonCode, etc.)
   * @returns {Object} Prompt to execute
   */
  buildSkillPrompt: (params) => {
    const { userRequest, sourceTableSchema, operationType = 'sql', settings = {}, currentState = {} } = params;

    // Build the main prompt similar to nedbTransformationNewTable
    const sourceTableInfo = `
Source: ${sourceTableSchema.sourceNodeLabel || 'Unknown'}
- Table/Collection name: ${sourceTableSchema.tableName}
- Columns/Fields: ${JSON.stringify(sourceTableSchema.columns || [])}
- Sample data (first 5 rows/documents): ${JSON.stringify(sourceTableSchema.sampleData || [])}
    `;

    const outputGuidance = operationType === 'sql'
      ? 'Output must be a list of dictionaries with consistent schema (all records have the same keys)'
      : 'Output can be a list of dictionaries with varying schemas (documents can have different fields)';

    const prompt = `You are a Python transformation expert using pandas and numpy.

Database Type: ${operationType === 'sql' ? 'SQL (Structured)' : 'NoSQL (Document-based)'}
User's request: "${userRequest}"

${sourceTableInfo}

Target Collection/Table: ${settings.tableName || 'transformed_data'}
Storage Location: ${settings.storageLocation || 'local'}
Available Libraries: pandas, numpy

**Your Task**:
Analyze the user's request and determine the appropriate action:

1. **unrelateSkill** - If the request is:
   - Not related to Python/pandas transformation
   - Asking about the data source (not transformation)
   - General questions about the workflow
   - Requesting a different type of operation

2. **answer_directly** - If the request is:
   - A question about the transformation you've already created
   - Asking for clarification about what the code does
   - General information query that doesn't need execution

3. **ask_questions** - If you need:
   - More details about the transformation logic
   - Clarification on column names or operations
   - User preferences for handling edge cases

4. **execute** - When you're ready to execute:
   - User has provided all necessary information
   - You have complete Python transformation code
   - Code includes a transform(data) function

**Python Code Requirements**:
- Must define: \`def transform(data):\`
- Function receives: List of dictionaries (each dict is a row/document)
- Function returns: List of dictionaries (transformed data)
- Use pandas for data manipulation: \`df = pd.DataFrame(data)\`
- Return format: \`return df.to_dict('records')\`
- ${outputGuidance}
- Only import pandas and numpy (import pandas as pd, import numpy as np)

**Example Transformation**:
\`\`\`python
import pandas as pd
import numpy as np

def transform(data):
    # Convert to DataFrame
    df = pd.DataFrame(data)

    # Your transformation logic
    df['new_column'] = df['existing_column'] * 2

    # Return as list of dicts
    return df.to_dict('records')
\`\`\`

${currentState.pythonCode ? `\n**Current Python Code**:\n\`\`\`python\n${currentState.pythonCode}\n\`\`\`\n` : ''}

Return your response in JSON format:
{
  "action": "unrelateSkill" | "answer_directly" | "ask_questions" | "execute",
  "pythonCode": "Complete Python code (ONLY if action is 'execute')",
  "explanation": "Explanation of what you're doing or asking",
  "followUpQuestion": "Question for user (ONLY if action is 'ask_questions')",
  "directAnswer": "Answer to user's question (ONLY if action is 'answer_directly')",
  "reasoning": "Why you chose this action"
}`;

    // Return prompt for the chat component to execute
    return {
      prompt,
      context: {
        userRequest,
        sourceTableSchema,
        operationType
      }
    };
  },

  /**
   * Process the AI response
   * @param {String} aiResponse - Raw AI response
   * @param {String} operationType - 'sql' or 'nosql'
   * @returns {Object} Processed action
   */
  processSkillResponse: (aiResponse, operationType = 'sql') => {
    let analysis;
    try {
      analysis = JSON.parse(aiResponse);
    } catch (e) {
      console.error('[Python Executor] Failed to parse response:', e);
      return {
        action: 'ask_questions',
        followUpQuestion: 'I had trouble understanding. Could you please rephrase your transformation request?',
        explanation: 'Failed to parse AI response'
      };
    }

    // Validate and return the action
    if (analysis.action === 'execute') {
      // Validate Python code
      if (!analysis.pythonCode || !analysis.pythonCode.includes('def transform(')) {
        return {
          action: 'ask_questions',
          followUpQuestion: 'The Python code must include a `transform(data)` function. Please provide complete code.',
          explanation: 'Missing transform function'
        };
      }

      return {
        action: 'execute',
        pythonCode: analysis.pythonCode,
        explanation: analysis.explanation,
        operationType
      };
    }

    return analysis;
  },

  /**
   * Get prompts to add to transformation requests
   * This helps the AI understand it can use Python
   * @param {Object} context - Context information
   * @param {String} context.operationType - 'sql' or 'nosql'
   * @param {Object} context.sourceSchema - Source data schema
   */
  getTransformPrompts: (context = {}) => {
    const { operationType = 'sql', sourceSchema = {} } = context;

    const outputGuidance = operationType === 'sql'
      ? `
**IMPORTANT - SQL Output Format**:
- Return data as a list of dictionaries with consistent schema
- All records must have the same keys
- Use consistent data types for each column
- Example: [{"id": 1, "name": "John"}, {"id": 2, "name": "Jane"}]
`
      : `
**IMPORTANT - NoSQL Output Format**:
- Return data as a list of dictionaries (documents)
- Documents can have varying schemas
- Nested objects and arrays are allowed
- Example: [{"_id": "1", "data": {"nested": "value"}}, {"_id": "2", "tags": ["a", "b"]}]
`;

    return {
      systemContext: `
You have access to a Python Executor skill that can run Python code directly on the local machine.

**IMPORTANT**: The user must explicitly request Python or mention pandas/numpy for this skill to be used.
DO NOT use this skill unless the user specifically asks for:
- "use Python"
- "use pandas"
- "with pandas/numpy"
- Python-specific operations

When Python Executor is appropriate:
- User explicitly requested Python/pandas/numpy
- Complex data transformations requiring Python libraries
- Statistical analysis or machine learning operations
- Custom business logic that's too complex for SQL

${outputGuidance}

Available Libraries: pandas, numpy (only these two are available)

Python Code Requirements:
- Must define a function called 'transform(data)'
- The function receives data as a list of dictionaries
- The function must return a list of dictionaries matching the output format above
- Can only import pandas and numpy
- Handle errors gracefully

Example Python transformation:
\`\`\`python
import pandas as pd
import numpy as np

def transform(data):
    # Convert to DataFrame
    df = pd.DataFrame(data)

    # Perform transformation
    df['new_column'] = df['existing_column'] * 2
    df['calculated'] = df['value1'] + df['value2']

    # Return as list of dicts
    return df.to_dict('records')
\`\`\`
`,
      responseFormat: `
**Using Python Executor Skill**:
Only if user explicitly requested Python, return JSON:
{
  "usesSkill": true,
  "skillId": "python-executor",
  "skillParams": {
    "pythonCode": "Complete Python code with transform function"
  },
  "explanation": "Brief explanation of the transformation"
}

Otherwise use standard SQL/NoSQL transformation.
`
    };
  },

  /**
   * Analyze a request and determine if this skill should be used
   * This is called when AI indicates this skill should be used
   *
   * @param {Object} params - Analysis parameters
   * @param {String} params.userRequest - Original user request
   * @param {Object} params.skillParams - Parameters from AI response
   * @param {Object} params.sourceSchema - Source data schema
   * @param {Array} params.chatHistory - Conversation history
   * @param {String} params.operationType - 'sql' or 'nosql'
   * @returns {Promise<Object>} Analysis result
   */
  analyzeRequest: async (params) => {
    const { skillParams, sourceSchema, operationType = 'sql' } = params;

    // Check if we have Python code
    if (!skillParams || !skillParams.pythonCode) {
      return {
        action: 'ask_questions',
        followUpQuestion: 'Please provide the Python transformation code you\'d like to execute.',
        questionsNeeded: { pythonCode: true }
      };
    }

    // Validate Python code has transform function
    if (!skillParams.pythonCode.includes('def transform(')) {
      return {
        action: 'ask_questions',
        followUpQuestion: 'The Python code must include a `transform(data)` function. Please provide valid Python code.',
        questionsNeeded: { pythonCode: true }
      };
    }

    // Ready to execute
    return {
      action: 'generate_transformation',
      skillParams: {
        ...skillParams,
        operationType // Pass operationType to execution
      }
    };
  },

  /**
   * Format the execution result to match transformation output format
   * @param {Object} result - Raw execution result
   * @param {String} operationType - 'sql' or 'nosql'
   * @returns {Object} - Formatted result matching applyTransformationResult format
   */
  formatTransformationResult: (result, operationType = 'sql') => {
    if (!result.success) {
      return {
        success: false,
        message: result.error || 'Python execution failed',
        error: result.error
      };
    }

    return {
      success: true,
      message: `Python transformation completed successfully. Processed ${result.recordCount} records.`,
      data: result.data,
      recordCount: result.recordCount,
      operationType: operationType,
      executionDetails: {
        skillId: 'python-executor',
        skillName: 'Python Executor',
        stdout: result.stdout,
        executionTime: result.executionTime
      }
    };
  },

  /**
   * Execute Python transformation
   * @param {Object} params - Execution parameters
   * @param {Object} params.sourceConnection - Source connection info
   * @param {Object} params.sourceTableSchema - Source table schema
   * @param {String} params.pythonCode - Python code to execute
   * @param {String} params.pythonPath - Optional custom Python path
   * @param {String} params.operationType - 'sql' or 'nosql'
   * @param {Object} params.pluginManager - Plugin manager instance
   * @param {Function} params.getFullConfig - Function to get full config with credentials
   * @returns {Promise<Object>} - Result with transformed data
   */
  execute: async (params) => {
    const {
      sourceConnection,
      sourceTableSchema,
      pythonCode,
      pythonPath = 'python3',
      operationType = 'sql',
      pluginManager,
      getFullConfig,
      appSqliteDbPath,
      sqlitePool
    } = params;
    const startTime = Date.now();

    try {
      console.log('[Python Executor] Step 1: Loading source data...');

      // Step 1: Pull data from source (similar to executeOutput)
      let sourceData = [];
      const isLocalFile = sourceConnection.localPath;

      if (isLocalFile) {
        // Local file - load directly
        if (sourceConnection.dbType === 'nedb') {
          const Datastore = require('@seald-io/nedb');
          // NeDB doesn't use table names in queries, just the file path
          const db = new Datastore({ filename: sourceConnection.localPath, autoload: false });

          await new Promise((resolve, reject) => {
            db.loadDatabase((err) => err ? reject(err) : resolve());
          });

          sourceData = await new Promise((resolve, reject) => {
            db.find({}).limit(1000000).exec((err, docs) => {
              if (err) reject(err);
              else resolve(docs);
            });
          });

          console.log(`[Python Executor] Loaded ${sourceData.length} documents from local NeDB`);
        } else if (sourceConnection.dbType === 'sqlite') {
          const sqlite3 = require('sqlite3').verbose();
          const db = new sqlite3.Database(sourceConnection.localPath);

          // For SQLite, use the original table name (no schema quoting needed for local files)
          const tableName = sourceTableSchema.originalTableName || sourceTableSchema.tableName;
          const query = `SELECT * FROM ${tableName}`;
          sourceData = await new Promise((resolve, reject) => {
            db.all(query, (err, rows) => {
              if (err) reject(err);
              else resolve(rows);
            });
          });

          db.close();
          console.log(`[Python Executor] Loaded ${sourceData.length} rows from local SQLite`);
        }
      } else {
        // Remote connection - use plugin system
        const plugin = pluginManager.getConnector(sourceConnection.dbType);

        if (!plugin) {
          throw new Error(`Plugin not found for database type: ${sourceConnection.dbType}`);
        }

        // Use the quoted tableName for SQL (already includes schema if needed)
        // Use originalTableName for NoSQL collections (no schema needed)
        const isNoSQLDb = ['mongodb', 'nedb'].includes(sourceConnection.dbType);
        const tableNameForQuery = isNoSQLDb
          ? (sourceTableSchema.originalTableName || sourceTableSchema.tableName)
          : sourceTableSchema.tableName;

        const sqlQuery = `SELECT * FROM ${sourceTableSchema.tableName}`; // Already quoted with schema

        const queryObj = {
          // For SQL databases
          query: sqlQuery,
          tableName: tableNameForQuery,
          schema: sourceTableSchema.schema || sourceConnection.dbConfig?.schema,

          // For MongoDB
          collection: tableNameForQuery,
          filter: {},

          // For Google Sheets
          spreadsheetId: tableNameForQuery,
          sheetName: sourceTableSchema.sheetName,
          range: null,

          // Common
          limit: 1000000
        };

        const fullConfig = await getFullConfig(sourceConnection.id, sourceConnection.dbConfig || {});
        const result = await plugin.runQuery(fullConfig, sourceConnection.id, queryObj);
        sourceData = result.rows || [];

        console.log(`[Python Executor] Loaded ${sourceData.length} rows from remote connection`);
      }

      if (!sourceData || sourceData.length === 0) {
        return {
          success: false,
          error: 'No data loaded from source. Cannot execute transformation on empty dataset.',
          executionTime: Date.now() - startTime
        };
      }

      console.log('[Python Executor] Step 2: Executing Python transformation...');

      // Step 2: Execute Python transformation on loaded data
      const data = sourceData;

      // Create temporary directory for execution
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ternlux-python-'));
      const scriptPath = path.join(tempDir, 'transform_script.py');
      const inputPath = path.join(tempDir, 'input.json');
      const outputPath = path.join(tempDir, 'output.json');

      // Prepare input data
      const inputData = Array.isArray(data) ? data : [data];

      // Create the complete Python script
      const fullScript = `
import json
import sys
import math

# User's transformation code
${pythonCode}

# Helper function to clean NaN/Infinity values for JSON serialization
def clean_for_json(obj):
    """Recursively replace NaN and Infinity with None for valid JSON"""
    if isinstance(obj, list):
        return [clean_for_json(item) for item in obj]
    elif isinstance(obj, dict):
        return {key: clean_for_json(value) for key, value in obj.items()}
    elif isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return obj
    else:
        return obj

# Main execution
if __name__ == '__main__':
    try:
        # Read input data
        with open('${inputPath.replace(/\\/g, '\\\\')}', 'r', encoding='utf-8') as f:
            input_data = json.load(f)

        # Execute transformation
        result = transform(input_data)

        # Clean NaN/Infinity values before JSON serialization
        cleaned_result = clean_for_json(result)

        # Write output
        with open('${outputPath.replace(/\\/g, '\\\\')}', 'w', encoding='utf-8') as f:
            json.dump(cleaned_result, f, ensure_ascii=False, indent=2)

        print("Transformation completed successfully")
        sys.exit(0)
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        sys.exit(1)
`;

      // Write files
      await fs.writeFile(scriptPath, fullScript, 'utf-8');
      await fs.writeFile(inputPath, JSON.stringify(inputData, null, 2), 'utf-8');

      // Execute Python script
      const result = await new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';

        const pythonProcess = spawn(pythonPath, [scriptPath], {
          cwd: tempDir,
          env: process.env
        });

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        pythonProcess.on('close', async (code) => {
          if (code !== 0) {
            reject(new Error(`Python execution failed: ${stderr || 'Unknown error'}`));
            return;
          }

          try {
            // Read output
            const outputData = await fs.readFile(outputPath, 'utf-8');
            const parsedOutput = JSON.parse(outputData);

            // Cleanup
            await fs.rm(tempDir, { recursive: true, force: true });

            resolve({
              success: true,
              data: parsedOutput,
              stdout: stdout,
              recordCount: Array.isArray(parsedOutput) ? parsedOutput.length : 1,
              executionTime: Date.now() - startTime
            });
          } catch (err) {
            reject(new Error(`Failed to read output: ${err.message}`));
          }
        });

        pythonProcess.on('error', (err) => {
          reject(new Error(`Failed to start Python: ${err.message}`));
        });

        // Timeout after 5 minutes
        setTimeout(() => {
          pythonProcess.kill();
          reject(new Error('Python execution timed out after 5 minutes'));
        }, 5 * 60 * 1000);
      });

      console.log('[Python Executor] Step 3: Saving transformed data...');

      // Step 3: Save transformed data to local file
      const { data: transformedData, recordCount, executionTime } = result;
      const isNoSQL = operationType === 'nosql';
      const targetDbType = isNoSQL ? 'nedb' : 'sqlite';

      // Generate target table/collection name from node ID or use default
      const nodeId = params.nodeId || `transform_${Date.now()}`;
      const targetTableName = nodeId.replace(/-/g, '_').toLowerCase();

      let localPath;
      let targetPreviewSql;

      if (isNoSQL) {
        // Save to NeDB - create specific directory for NeDB files
        const outputDir = path.join(process.cwd(), 'data', 'skills', 'python-executor');
        await fs.mkdir(outputDir, { recursive: true });
        localPath = path.join(outputDir, `${targetTableName}.db`);
        const Datastore = require('@seald-io/nedb');
        const db = new Datastore({ filename: localPath });

        await new Promise((resolve, reject) => {
          db.loadDatabase((err) => err ? reject(err) : resolve());
        });

        // Insert transformed data
        const docsToInsert = Array.isArray(transformedData) ? transformedData : [transformedData];
        await new Promise((resolve, reject) => {
          db.insert(docsToInsert, (err, newDocs) => {
            if (err) reject(err);
            else resolve(newDocs);
          });
        });

        console.log(`[Python Executor] Saved ${docsToInsert.length} documents to NeDB: ${localPath}`);

        targetPreviewSql = JSON.stringify({
          collection: targetTableName,
          filter: {},
          limit: 100
        });
      } else {
        // Save to SQLite - use app-wide SQLite database
        if (!appSqliteDbPath) {
          throw new Error('App SQLite database path not provided');
        }

        if (!sqlitePool) {
          throw new Error('SQLite connection pool not provided');
        }

        localPath = appSqliteDbPath;

        // Use connection pool to write data
        await sqlitePool.executeWrite(async (db) => {
          // Infer schema from first record
          const firstRecord = Array.isArray(transformedData) && transformedData.length > 0
            ? transformedData[0]
            : transformedData;

          if (!firstRecord || typeof firstRecord !== 'object') {
            throw new Error('Cannot create table: transformed data is not an object or array of objects');
          }

          // Drop table if exists
          await new Promise((resolve, reject) => {
            db.run(`DROP TABLE IF EXISTS ${targetTableName}`, (err) => {
              if (err) reject(err);
              else resolve();
            });
          });

          // Create table
          const columns = Object.keys(firstRecord).map(key => {
            const value = firstRecord[key];
            const type = typeof value === 'number'
              ? (Number.isInteger(value) ? 'INTEGER' : 'REAL')
              : 'TEXT';
            return `${key} ${type}`;
          }).join(', ');

          const createTableSQL = `CREATE TABLE ${targetTableName} (${columns})`;
          await new Promise((resolve, reject) => {
            db.run(createTableSQL, (err) => err ? reject(err) : resolve());
          });

          // Insert data
          const rowsToInsert = Array.isArray(transformedData) ? transformedData : [transformedData];
          const columnNames = Object.keys(firstRecord);
          const placeholders = columnNames.map(() => '?').join(', ');
          const insertSQL = `INSERT INTO ${targetTableName} (${columnNames.join(', ')}) VALUES (${placeholders})`;

          for (const row of rowsToInsert) {
            const values = columnNames.map(col => row[col]);
            await new Promise((resolve, reject) => {
              db.run(insertSQL, values, (err) => err ? reject(err) : resolve());
            });
          }

          console.log(`[Python Executor] Saved ${rowsToInsert.length} rows to SQLite: ${localPath}`);
        });

        targetPreviewSql = `SELECT * FROM ${targetTableName} LIMIT 100`;
      }

      // Build config object for TransformerNodeChat to save
      const sourceConfig = params.sourceNodeConfig || {};

      console.log('[Python Executor] Step 4: Building config...');

      const config = {
        nodeType: 'transformer',
        sourceNodeId: params.sourceNodeId,
        sourceNodeLabel: params.sourceNodeLabel,
        sourceConnectionId: sourceConnection.id,
        sourceConnectionName: params.sourceConnectionName,
        sourceConnectionType: sourceConnection.connectionType || params.sourceConnectionType,
        sourceDbType: sourceConnection.dbType,
        sourceDbConfig: sourceConnection.dbConfig,
        sourceType: sourceConnection.dbType,
        sourceLocalPath: sourceConnection.localPath,
        sourceTableName: sourceTableSchema.originalTableName || sourceTableSchema.tableName,
        sourceCollection: sourceConfig.targetCollection || sourceConfig.sourceCollection,
        sourceSchema: sourceTableSchema.schema,
        sourceTableSchema: sourceTableSchema,
        storagelocation: 'local',
        // Target configuration (local storage)
        targetConnectionId: `local-${targetDbType}`,
        targetConnectionName: targetDbType === 'nedb' ? 'Local NeDB' : 'Local SQLite',
        targetConnectionType: 'file',
        targetDbType: targetDbType,
        targetDbConfig: {},
        targetLocalPath: localPath,
        targetTableName: isNoSQL ? undefined : targetTableName,
        targetCollection: isNoSQL ? targetTableName : undefined,
        targetSchema: null,
        targetPreviewSql: targetPreviewSql,

        // Skill execution metadata
        skillExecution: {
          skillId: 'python-executor',
          executionTime: executionTime,
          recordCount: recordCount
        },
        transformationRequest: params.userRequest || 'Python-based transformation',

        // Indicator for frontend to load target table schema
        needsSchemaLoad: true
      };

      return {
        success: true,
        data: transformedData,
        recordCount: recordCount,
        localPath: localPath,
        targetTableName: targetTableName,
        message: `Transformed ${recordCount} records using Python`,
        executionDetails: {
          executionTime: executionTime
        },
        config: config
      };

    } catch (error) {
      console.error('[Python Executor] Error during data loading or transformation:', error);
      return {
        success: false,
        error: error.message,
        executionTime: Date.now() - startTime
      };
    }
  },

  /**
   * Test if Python is available
   */
  testEnvironment: async (pythonPath = 'python3') => {
    try {
      const result = await new Promise((resolve, reject) => {
        const pythonProcess = spawn(pythonPath, ['--version']);

        let version = '';
        pythonProcess.stdout.on('data', (data) => {
          version += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          version += data.toString();
        });

        pythonProcess.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true, version: version.trim() });
          } else {
            reject(new Error('Python not found'));
          }
        });

        pythonProcess.on('error', (err) => {
          reject(err);
        });

        setTimeout(() => {
          pythonProcess.kill();
          reject(new Error('Timeout checking Python version'));
        }, 5000);
      });

      return result;
    } catch (error) {
      return {
        success: false,
        message: error.message
      };
    }
  },

  /**
   * Get available Python libraries
   */
  getAvailableLibraries: async (pythonPath = 'python3') => {
    try {
      const libraries = await new Promise((resolve, reject) => {
        const pythonProcess = spawn(pythonPath, ['-m', 'pip', 'list', '--format=json']);

        let output = '';
        pythonProcess.stdout.on('data', (data) => {
          output += data.toString();
        });

        pythonProcess.on('close', (code) => {
          if (code === 0) {
            try {
              const libs = JSON.parse(output);
              resolve(libs);
            } catch (err) {
              resolve([]);
            }
          } else {
            resolve([]);
          }
        });

        pythonProcess.on('error', () => {
          resolve([]);
        });

        setTimeout(() => {
          pythonProcess.kill();
          resolve([]);
        }, 10000);
      });

      return {
        success: true,
        libraries
      };
    } catch (error) {
      return {
        success: false,
        libraries: []
      };
    }
  },

  /**
   * Check if required Python packages are installed
   */
  checkDependencies: async (pythonPath = 'python3') => {
    try {
      // Create a small Python script to check for packages
      const checkScript = `
import sys
import json

packages = {
    'pandas': False,
    'numpy': False,
    'scipy': False,
    'sklearn': False
}

for package in packages.keys():
    try:
        __import__(package if package != 'sklearn' else 'sklearn')
        packages[package] = True
    except ImportError:
        pass

print(json.dumps(packages))
`;

      const result = await new Promise((resolve, reject) => {
        let output = '';
        const pythonProcess = spawn(pythonPath, ['-c', checkScript]);

        pythonProcess.stdout.on('data', (data) => {
          output += data.toString();
        });

        pythonProcess.on('close', (code) => {
          if (code === 0) {
            try {
              const packages = JSON.parse(output.trim());
              resolve({
                success: true,
                packages,
                allInstalled: Object.values(packages).every(v => v)
              });
            } catch (err) {
              reject(new Error('Failed to parse package check output'));
            }
          } else {
            reject(new Error('Package check failed'));
          }
        });

        pythonProcess.on('error', (err) => {
          reject(err);
        });

        setTimeout(() => {
          pythonProcess.kill();
          reject(new Error('Package check timed out'));
        }, 5000);
      });

      return result;
    } catch (error) {
      return {
        success: false,
        message: error.message,
        packages: {},
        allInstalled: false
      };
    }
  },

  /**
   * Plugin metadata
   */
  metadata: {
    displayName: 'Python Executor',
    description: 'Execute Python code for complex data transformations',
    version: '1.0.0',
    author: 'Ternlux',
    requires: ['python3'],
    recommendedLibraries: ['pandas', 'numpy', 'scipy', 'scikit-learn'],
    setupInstructions: 'Run setup.sh (Unix/macOS) or setup.bat (Windows) to install Python dependencies',
    documentationUrl: 'https://docs.python.org/3/'
  }
};
