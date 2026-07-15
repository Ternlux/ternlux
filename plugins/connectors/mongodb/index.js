/**
 * MongoDB Connector Plugin for Ternlux
 * Handles all MongoDB database operations
 */

const mongoose = require('mongoose');

// Connection cache
const connections = new Map();

/**
 * Get or create MongoDB connection
 */
async function getConnection(config, connectionId) {
  const key = connectionId || JSON.stringify(config);
  const uri = config.uri;

  if (!uri) {
    throw new Error('MongoDB URI is required');
  }

  if (!connections.has(key)) {
    const connection = await mongoose.createConnection(uri, {
      serverSelectionTimeoutMS: 8000,
      maxPoolSize: 10,
      minPoolSize: 0,
    }).asPromise();

    connections.set(key, connection);
  }

  return connections.get(key);
}

module.exports = {
  type: 'connector',
  id: 'mongodb',
  name: 'MongoDB',
  icon: './icon.svg',
  dbCategory: 'NoSQL',

  /**
   * Test database connection
   */
  testConnection: async (config, connectionId = null) => {
    try {
      const uri = config.uri;
      if (!uri) {
        return { success: false, message: 'MongoDB URI is required' };
      }

      const connection = mongoose.createConnection(uri, {
        serverSelectionTimeoutMS: 8000
      });
      await connection.asPromise();
      await connection.close();
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Get list of collections
   */
  getTables: async (config, connectionId = null) => {
    try {
      const connection = await getConnection(config, connectionId);
      const db = connection.db;
      const dbName = db.databaseName;

      const collections = await db.listCollections().toArray();

      return {
        success: true,
        tables: collections.map(c => ({
          schema: dbName,
          name: c.name,
          type: 'COLLECTION'
        }))
      };
    } catch (error) {
      return { success: false, message: error.message, tables: [] };
    }
  },

  /**
   * Get collection fields (inferred from documents)
   */
  getColumns: async (config, connectionId, schema, table) => {
    try {
      const connection = await getConnection(config, connectionId);

      // If schema (database name) is provided, switch to it
      const db = schema
        ? connection.useDb(schema).db
        : connection.db;

      const coll = db.collection(table);

      const docs = await coll
        .find({})
        .limit(100)
        .toArray();

      const fields = new Set();
      docs.forEach(doc => {
        Object.keys(doc).forEach(key => fields.add(key));
      });

      const columns = Array.from(fields).map(field => ({
        name: field,
        type: 'mixed',
        nullable: 'YES',
        isPrimary: field === '_id'
      }));

      return { success: true, columns };
    } catch (error) {
      return { success: false, message: error.message, columns: [] };
    }
  },

  /**
   * Run MongoDB query (expects JSON with collection, filter, limit)
   * Also supports operation types: drop, insertMany
   */
  runQuery: async (config, connectionId, query, limit=100) => {
    try {
      const connection = await getConnection(config, connectionId);
      query = query?.query ? query.query : query;
      const params = typeof query === 'string' ? JSON.parse(query) : query;
      const db = connection.db;

      // Handle different operation types. An explicit `operation: "find"` is
      // the same as omitting `operation` — fall through to the default find
      // path below instead of failing with "Unknown operation type: find".
      if (params.operation && params.operation !== 'find') {
        const coll = db.collection(params.collection);

        switch (params.operation) {
          case 'drop':
            // Drop collection
            try {
              await coll.drop();
              return {
                success: true,
                message: `Collection "${params.collection}" dropped successfully`,
                rowCount: 0
              };
            } catch (err) {
              // If collection doesn't exist, that's fine
              if (err.code === 26) { // NamespaceNotFound
                return {
                  success: true,
                  message: `Collection "${params.collection}" does not exist`,
                  rowCount: 0
                };
              }
              throw err;
            }

          case 'insertMany':
            // Insert many documents
            const result = await coll.insertMany(params.documents);
            return {
              success: true,
              message: `Inserted ${result.insertedCount} documents into "${params.collection}"`,
              rowCount: result.insertedCount,
              insertedCount: result.insertedCount
            };

          case 'count': {
            // Document count for params.filter (defaults to all docs).
            const n = await coll.countDocuments(params.filter || {});
            return {
              success: true,
              rows: [{ count: n }],
              columns: ['count'],
              rowCount: 1,
              count: n,
              json: true,
            };
          }

          case 'aggregate': {
            // Run an aggregation pipeline. `params.pipeline` is required.
            if (!Array.isArray(params.pipeline)) {
              return { success: false, message: 'aggregate requires params.pipeline (array)' };
            }
            const docs = await coll.aggregate(params.pipeline).toArray();
            const columns = docs.length ? Object.keys(docs[0]) : [];
            return {
              success: true,
              rows: docs,
              columns,
              rowCount: docs.length,
              json: true,
            };
          }

          default:
            return {
              success: false,
              message: `Unknown operation type: ${params.operation}`
            };
        }
      }

      // Default: run find query (honors optional sort / projection)
      const coll = db.collection(params.collection);
      let cursor = coll.find(params.filter || {});
      if (params.sort) cursor = cursor.sort(params.sort);
      if (params.projection) cursor = cursor.project(params.projection);
      const docs = await cursor
        .limit(params.limit || limit)
        .toArray();

      const columns = docs.length ? Object.keys(docs[0]) : [];

      return {
        success: true,
        rows: docs,
        columns,
        rowCount: docs.length,
        json: true
      };
    } catch (error) {
      console.log('error: ', error)
      return { success: false, message: error.message, rows: [], columns: [] };
    }
  },

  /**
   * Transform MongoDB data (aggregation, filter, update, delete, javascript)
   */
  transformData: async (config, connectionId, {
    sourceCollection,
    targetCollection,
    operationType,
    nosqlOperation,
    transformFunction,
    storageLocation,
    operationMode
  }) => {
    try {
      console.log('transformData: ',     sourceCollection,
      targetCollection,
      operationType,
      nosqlOperation,
      transformFunction,
      storageLocation,
      operationMode)
      const uri = config.uri;

      if (!uri) {
        return { success: false, message: 'MongoDB URI is required' };
      }

      const connection = await mongoose
        .createConnection(uri, { serverSelectionTimeoutMS: 8000 })
        .asPromise();

      const db = connection.db;
      const sourceColl = db.collection(sourceCollection);

      let transformedDocs = [];
      let totalProcessed = 0;

      // Parse the transform function if provided
      let transformFn = null;
      if (transformFunction) {
        try {
          // Create function from string
          transformFn = eval(`(${transformFunction})`);
        } catch (err) {
          await connection.close();
          return { success: false, message: `Failed to parse transform function: ${err.message}` };
        }
      }

      // Handle different operation types
      if (operationType === 'aggregation') {
        // Parse aggregation pipeline
        const pipeline = JSON.parse(nosqlOperation);

        if (storageLocation === 'database' && operationMode === 'new_table') {
          // Drop the target collection if it exists before creating new one
          try {
            await db.collection(targetCollection).drop();
          } catch (err) {
            // Ignore error if collection doesn't exist
            if (err.code !== 26) {  // 26 = NamespaceNotFound
              console.warn('Could not drop collection:', err.message);
            }
          }

          // Run aggregation and output to new collection in database
          if(!pipeline.find((e) => e.$out)) pipeline.push({ $out: targetCollection });
          await sourceColl.aggregate(pipeline).toArray();

          const targetColl = db.collection(targetCollection);
          const count = await targetColl.countDocuments();

          await connection.close();
          return {
            success: true,
            message: `Aggregation completed. ${count} documents in new collection "${targetCollection}"`,
            documentsProcessed: count
          };
        } else {
          // Stream aggregation results
          const cursor = sourceColl.aggregate(pipeline);

          for await (const doc of cursor) {
            totalProcessed++;

            // Apply JavaScript transformation if provided
            const finalDoc = transformFn ? transformFn(doc) : doc;

            if (finalDoc !== null && finalDoc !== undefined) {
              transformedDocs.push(finalDoc);
            }
          }
        }

      } else if (operationType === 'delete') {
        // Parse delete filter
        const filter = JSON.parse(nosqlOperation);

        if (operationMode === 'in_place') {
          const result = await sourceColl.deleteMany(filter);
          await connection.close();
          return {
            success: true,
            message: `Deleted ${result.deletedCount} documents`,
            documentsProcessed: result.deletedCount
          };
        }

      } else if (operationType === 'update') {
        // Parse update operation
        const updateOp = JSON.parse(nosqlOperation);

        if (operationMode === 'in_place') {
          const result = await sourceColl.updateMany(
            updateOp.filter,
            updateOp.update
          );
          await connection.close();
          return {
            success: true,
            message: `Updated ${result.modifiedCount} documents`,
            documentsProcessed: result.modifiedCount
          };
        }

      } else if (operationType === 'javascript') {
        // JavaScript transformation with optional filter
        const filter = nosqlOperation ? JSON.parse(nosqlOperation) : {};

        // For in-place mode with JavaScript transformation, process in batches
        if (operationMode === 'in_place' && transformFn) {
          const BATCH_SIZE = 10000;
          let skip = 0;
          let totalUpdated = 0;

          while (true) {
            // Fetch batch of documents
            const docs = await sourceColl.find(filter).skip(skip).limit(BATCH_SIZE).toArray();

            if (docs.length === 0) {
              break; // No more documents to process
            }

            // Process batch: transform and prepare bulk update operations
            const bulkOps = [];
            for (const doc of docs) {
              totalProcessed++;

              try {
                const transformedDoc = transformFn(doc);

                if (transformedDoc !== null && transformedDoc !== undefined) {
                  // Remove _id from transformed doc to avoid update errors
                  const { _id, ...updateFields } = transformedDoc;
                  console.log('updateFields: ', updateFields, doc._id)
                  // Prepare bulk update operation
                  bulkOps.push({
                    updateOne: {
                      filter: { _id: doc._id },
                      update: { $set: updateFields }
                    }
                  });
                }
              } catch (transformErr) {
                console.error(`Transform error for doc ${doc._id}:`, transformErr);
              }
            }
            // console.log('bulkOps: ', bulkOps)
            // Execute bulk update for this batch
            if (bulkOps.length > 0) {
              const result = await sourceColl.bulkWrite(bulkOps);
              totalUpdated += result.modifiedCount;
            }

            skip += BATCH_SIZE;
          }

          await connection.close();
          return {
            success: true,
            message: `JavaScript transformation completed. ${totalUpdated} documents updated in place (${totalProcessed} documents processed)`,
            documentsProcessed: totalProcessed,
            documentsUpdated: totalUpdated
          };
        }

        // For new_table mode, collect all transformed documents
        const cursor = sourceColl.find(filter);

        for await (const doc of cursor) {
          totalProcessed++;

          if (transformFn) {
            const transformedDoc = transformFn(doc);

            if (transformedDoc !== null && transformedDoc !== undefined) {
              transformedDocs.push(transformedDoc);
            }
          }
        }
      } else if (operationType === 'filter') {
        // Simple filter operation
        const filter = JSON.parse(nosqlOperation);

        const cursor = sourceColl.find(filter);

        for await (const doc of cursor) {
          totalProcessed++;

          // Apply JavaScript transformation if provided
          const finalDoc = transformFn ? transformFn(doc) : doc;

          if (finalDoc !== null && finalDoc !== undefined) {
            transformedDocs.push(finalDoc);
          }
        }
      }

      // Handle where to store the results (database only - local storage handled in electron.js)
      if (transformedDocs.length > 0) {
        if (storageLocation === 'database') {
          // Drop the target collection if it exists before creating new one
          if (operationMode === 'new_table') {
            try {
              await db.collection(targetCollection).drop();
            } catch (err) {
              // Ignore error if collection doesn't exist
              if (err.code !== 26) {  // 26 = NamespaceNotFound
                console.warn('Could not drop collection:', err.message);
              }
            }
          }

          // Insert into new collection in MongoDB
          const targetColl = db.collection(targetCollection);
          await targetColl.insertMany(transformedDocs);
          await connection.close();

          return {
            success: true,
            message: `Transformation completed. ${transformedDocs.length} documents inserted into "${targetCollection}"`,
            documentsProcessed: totalProcessed,
            documentsInserted: transformedDocs.length
          };
        } else {
          // For local storage, return the documents for electron.js to handle
          await connection.close();
          return {
            success: true,
            transformedDocs,
            totalProcessed,
            needsLocalStorage: true
          };
        }
      }

      await connection.close();
      return {
        success: true,
        message: `Transformation completed. ${totalProcessed} documents processed, 0 output (all filtered out)`,
        documentsProcessed: totalProcessed,
        documentsInserted: 0
      };

    } catch (err) {
      return {
        success: false,
        message: `Transformation failed: ${err.message}`,
        error: err.stack
      };
    }
  },

  /**
   * Close MongoDB connection
   */
  closeConnection: async (connectionId) => {
    if (connections.has(connectionId)) {
      const connection = connections.get(connectionId);
      await connection.close();
      connections.delete(connectionId);
    }
  },

  /**
   * Batch insert documents into a collection (uses insertMany with ordered: false)
   */
  batchInsert: async (config, connectionId, collectionName, columns, rows) => {
    try {
      if (!rows || rows.length === 0) {
        return { success: true, rowsInserted: 0 };
      }

      const connection = await getConnection(config, connectionId);
      const db = connection.db(config.database);
      const collection = db.collection(collectionName);

      // Convert rows to MongoDB documents
      const documents = rows.map(row => {
        const doc = {};
        columns.forEach(col => {
          const val = row[col];
          if (val !== null && val !== undefined) {
            doc[col] = val;
          }
        });
        return doc;
      });

      // Use insertMany with ordered: false for better performance
      const result = await collection.insertMany(documents, { ordered: false });

      return {
        success: true,
        rowsInserted: result.insertedCount
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  },

  /**
   * Configuration schema for UI generation
   */
  configSchema: {
    fields: [
      {
        name: 'uri',
        type: 'string',
        label: 'Connection URI',
        placeholder: 'mongodb://localhost:27017/mydb',
        required: true,
        sensitive: true,
        helpText: 'Full MongoDB connection string (e.g., mongodb://user:pass@host:port/database)'
      }
    ]
  },

  /**
   * Get transformation prompts for LLM
   * Returns prompts for generating transformations specific to MongoDB
   */
  getTransformPrompts: () => ({
    newTable: (settings, sourceTableInfo, settingsContext, sourceTableSchema, targetTableName) => `You are a MongoDB expert helping create a new transformed collection.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Source Collection: ${sourceTableSchema.tableName}
    Target Collection: ${targetTableName}
    Storage Location: ${settings.storageLocation === 'database' ? 'MongoDB database' : 'Local file'}

    **Instructions**:

    You are creating a NEW collection with transformed data. Choose the appropriate transformation approach:

    1. **Aggregation Pipeline** (Recommended for MongoDB):
       - Use for: filtering, grouping, projecting fields, lookups, mathematical operations
       - Most efficient for complex transformations
       - Returns aggregation pipeline as JSON array
       - The $out stage is injected automatically, don't include it

    2. **Filter Operation**:
       - Simple document filtering based on criteria
       - Returns filter object

    3. **JavaScript Transformation**:
       - Use when aggregation cannot handle the transformation
       - Complex string manipulations, custom business logic, conditional transformations
       - Returns a JavaScript function that transforms each document
       - Function signature: function transformDocument(doc) { return transformedDoc; }
       - Return null to exclude a document from the output

    **Important Notes**:
    - You are creating a NEW collection, not modifying the source
    - All source documents matching your criteria will be transformed and inserted into "${targetTableName}"
    - For explanations text to bolden key points use **text** and to break lines use \\n
    - Placeholders like {{current_date}}, {{current_timestamp}} will be replaced at runtime

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of the transformation approach",
      "operationType": "aggregation" | "filter" | "javascript",
      "nosqlOperation": "MongoDB aggregation pipeline array or filter object as JSON string",
      "transformFunction": "JavaScript function code as string (ONLY if operationType is 'javascript', otherwise null). Also still provide nosqlOperation for the query filter"
    }

    **Examples**:

    Aggregation (filtering + projection):
    {
      "explanation": "Filter orders over $100 and project customer info",
      "operationType": "aggregation",
      "nosqlOperation": "[{ \\"$match\\": { \\"total\\": { \\"$gt\\": 100 } } }, { \\"$project\\": { \\"customerId\\": 1, \\"total\\": 1, \\"date\\": 1 } }]",
      "transformFunction": null
    }

    Filter operation:
    {
      "explanation": "Filter documents matching criteria",
      "operationType": "filter",
      "nosqlOperation": "{ \\"status\\": \\"active\\", \\"total\\": { \\"$gt\\": 100 } }",
      "transformFunction": null
    }

    JavaScript transformation:
    {
      "explanation": "Custom validation and formatting that requires complex logic",
      "operationType": "javascript",
      "nosqlOperation": "{ \\"status\\": \\"active\\" }",
      "transformFunction": "function transformDocument(doc) { if (!doc.email || !doc.email.includes('@')) return null; return { ...doc, email: doc.email.toLowerCase().trim(), validated: true }; }"
    }

    Provide working MongoDB operations.`,

    inPlace: (settings, sourceTableInfo, settingsContext, sourceTableSchema) => `You are a MongoDB expert helping modify data in-place.

    User's transformation request: "${settings.userRequest}"

    ${sourceTableInfo}

    ${settingsContext}

    Source Collection: ${sourceTableSchema.tableName}
    Operation Mode: In-Place (modifying source collection directly)

    **Instructions**:

    You are modifying the EXISTING collection. Choose the appropriate operation:

    1. **Delete Operation**:
       - Remove documents that match specific criteria
       - Returns deleteMany filter object
       - Documents matching the filter will be permanently deleted from "${sourceTableSchema.tableName}"

    2. **Update Operation**:
       - Update fields in documents that match specific criteria
       - Returns filter object and update operations
       - Uses MongoDB update operators like $set, $unset, $inc, etc.
       - Best for simple updates (setting values, incrementing, removing fields)

    3. **JavaScript Transformation** (for complex logic):
       - Use when update operators cannot handle the transformation
       - Complex string manipulations, conditional logic, calculations across multiple fields
       - Returns a JavaScript function that transforms each document in-place
       - Function signature: function transformDocument(doc) { /* modify doc fields */ return doc; }
       - Documents are processed in batches of 10,000 for efficiency
       - Return the modified document (do NOT return null to skip - that's not supported for in-place updates)
       - nosqlOperation should contain the filter to select documents to transform

    **Important Notes**:
    - You are MODIFYING the source collection "${sourceTableSchema.tableName}" directly
    - Changes are permanent and irreversible
    - Delete removes documents completely from the collection
    - Update modifies existing documents in-place (using MongoDB operators)
    - JavaScript transformation modifies documents in-place with custom logic (processed in 10k batches)
    - For explanations text to bolden key points use **text** and to break lines use \\n
    - Placeholders like {{current_date}}, {{current_timestamp}} will be replaced at runtime

    Return your response in this JSON format:
    {
      "explanation": "Brief explanation of what will be deleted or updated and why",
      "operationType": "delete" | "update" | "javascript",
      "nosqlOperation": "For delete: filter object. For update: { \\"filter\\": {...}, \\"update\\": {...} }. For javascript: filter object as JSON string",
      "transformFunction": "JavaScript function code as string (ONLY if operationType is 'javascript', otherwise null)"
    }

    **Examples**:

    Delete operation:
    {
      "explanation": "Delete all cancelled orders from the collection",
      "operationType": "delete",
      "nosqlOperation": "{ \\"status\\": \\"cancelled\\" }",
      "transformFunction": null
    }

    Update operation:
    {
      "explanation": "Mark all old orders as archived",
      "operationType": "update",
      "nosqlOperation": "{ \\"filter\\": { \\"createdAt\\": { \\"$lt\\": \\"2024-01-01\\" } }, \\"update\\": { \\"$set\\": { \\"archived\\": true, \\"archivedDate\\": \\"{{current_date}}\\" } } }",
      "transformFunction": null
    }

    Update with multiple fields:
    {
      "explanation": "Update pricing for premium products",
      "operationType": "update",
      "nosqlOperation": "{ \\"filter\\": { \\"category\\": \\"premium\\" }, \\"update\\": { \\"$set\\": { \\"discounted\\": true }, \\"$inc\\": { \\"price\\": -10 } } }",
      "transformFunction": null
    }

    JavaScript transformation (complex logic):
    {
      "explanation": "Apply complex pricing calculation based on multiple fields that cannot be done with update operators. Documents will be processed in batches of 10,000.",
      "operationType": "javascript",
      "nosqlOperation": "{ \\"status\\": \\"active\\" }",
      "transformFunction": "function transformDocument(doc) { if (doc.quantity > 100 && doc.category === 'premium') { doc.price = doc.price * 0.9; doc.discountApplied = true; } doc.lastModified = new Date().toISOString(); return doc; }"
    }

    Provide working MongoDB operations.`
  })
};
