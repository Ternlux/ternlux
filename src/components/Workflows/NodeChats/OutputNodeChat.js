import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { message as antdMessage } from 'antd';
import { connectionsDb } from '../../../utils/localDb';
import { loadTableSchema } from '../../../utils/tableSchemaUtils';
import CloudStorageBrowser from '../CloudStorageBrowser';
import {
  FileExcelOutlined,
  FileTextOutlined,
  DatabaseOutlined,
  ApiOutlined,
  CloudOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import { ReactComponent as PostgresIcon } from '../../ConnectorImages/Postgres.svg';
import { ReactComponent as MysqlIcon } from '../../ConnectorImages/Mysql.svg';
import { ReactComponent as MssqlIcon } from '../../ConnectorImages/Mssql.svg';
import { ReactComponent as MongodbIcon } from '../../ConnectorImages/Mongodb.svg';
import { ReactComponent as SqlliteIcon } from '../../ConnectorImages/Sqllite.svg';
import { ReactComponent as GoogleCloudStorageIcon } from '../../ConnectorImages/GoogleCloudStorage.svg';
import { ReactComponent as DropboxIcon } from '../../ConnectorImages/Dropbox.svg';
import { ReactComponent as GoogleDriveIcon } from '../../ConnectorImages/GoogleDrive.svg';
import { ReactComponent as GoogleSheetsIcon } from '../../ConnectorImages/GoogleSheets.svg';
import {
  FORM_ACCENT, GROUP_COLOR,
  FormScope, FormBody, FormFooter, Card, Fields, Field,
  Segmented, SelectInput, TextInput, PathPicker, Note, Handoff, HandoffBody,
  Picked, CloudButton, EmptyState, ConnList, ConnGroupToggle, ConnRow, IconFolder,
} from './_formShared';

// ─────────────────────────────────────────────────────────────────────────────
// Output Node configuration form
// Local Environment → format + native save dialog.
// Connection       → grouped destination list, then a table name (databases),
//                    an index name (vector) or a browsed upload path (cloud).
// Saving runs the output first, then persists the config.
// ─────────────────────────────────────────────────────────────────────────────

const VECTOR_DB_TYPES = new Set(['lancedb', 'pinecone']);

const FORMAT_OPTIONS = [
  { label: 'JSON — export as JSON file', value: 'json' },
  { label: 'CSV — export as CSV file', value: 'csv' },
  { label: 'Excel — export as .xlsx', value: 'excel' },
  { label: 'NeDB — local NeDB database', value: 'nedb' },
  { label: 'SQLite — local SQLite database', value: 'sqlite' },
  { label: 'LanceDB — local vector database', value: 'lancedb' },
  { label: 'Parquet — export as Parquet file', value: 'parquet' },
  { label: 'Avro — export as Avro file', value: 'avro' },
];

/**
 * A sheet name Excel will accept: at most 31 characters, none of `\ / ? * [ ] :`,
 * not wrapped in apostrophes. A table name is bound by none of that, so a name
 * derived from one is brought inside the rules before it is offered as the
 * default. Mirrors sanitizeSheetName in public/duckdb/xlsx.js, which applies the
 * same rules again at write time — this copy exists because the renderer cannot
 * reach into the main process's modules.
 */
const sanitizeSheetName = (name, fallback = 'Data') => {
  const cleaned = String(name || '')
    .replace(/[\\/?*[\]:]/g, '_')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31)
    .trim();
  return cleaned || fallback;
};

const GROUP_ORDER = ['Databases', 'Vector', 'Cloud Storage', 'APIs', 'Local Files', 'Other'];

/**
 * Undo the pre-quoting an earlier build applied before saving. The executor
 * quotes and schema-qualifies the name itself, so a stored `db`.`tbl` came back
 * doubled up ("Table 'db.tbl' doesn't exist"). Strip the quote characters and,
 * if the leading segment is just this connection's own database/schema, drop
 * it too — that qualifier gets re-added at run time.
 */
const normalizeSavedTableName = (raw, conn) => {
  if (!raw || !conn) return raw;
  const bare = String(raw).replace(/[`"[\]]/g, '');
  const parts = bare.split('.');
  if (parts.length !== 2) return bare;
  const qualifier = (conn.dbConfig?.database || conn.dbConfig?.schema || '').toLowerCase();
  if (qualifier && parts[0].toLowerCase() === qualifier) return parts[1];
  return bare;
};

const categorizeConnection = (conn) => {
  if (!conn) return 'Other';
  if (conn.dbCategory === 'CloudStorage') return 'Cloud Storage';
  if (conn.dbCategory === 'API' || conn.dbType === 'rest-api') return 'APIs';
  if (conn.dbCategory === 'Vector' || VECTOR_DB_TYPES.has(conn.dbType)) return 'Vector';
  if (conn.connectionType === 'database') return 'Databases';
  if (conn.connectionType === 'file') return 'Local Files';
  return 'Other';
};

const getDbIcon = (dbType) => {
  const iconMap = {
    postgres: PostgresIcon,
    mysql: MysqlIcon,
    mssql: MssqlIcon,
    mongodb: MongodbIcon,
    sqlite: SqlliteIcon,
    nedb: SqlliteIcon,
    gcs: GoogleCloudStorageIcon,
    dropbox: DropboxIcon,
    'google-drive': GoogleDriveIcon,
    'google-sheets': GoogleSheetsIcon,
  };
  return iconMap[dbType?.toLowerCase()] || null;
};

const getConnectionIcon = (connection) => {
  if (!connection) return null;
  const category = categorizeConnection(connection);
  if (category === 'APIs') return <ApiOutlined style={{ fontSize: 16 }} />;
  if (category === 'Vector') return <AppstoreOutlined style={{ fontSize: 16 }} />;
  if (category === 'Cloud Storage') {
    const IconComponent = getDbIcon(connection.dbType);
    return IconComponent ? <IconComponent /> : <CloudOutlined style={{ fontSize: 16 }} />;
  }
  if (connection.connectionType === 'file') {
    const fileName = connection.fileInfo?.fileName?.toLowerCase() || '';
    if (fileName.endsWith('.csv')) return <FileTextOutlined style={{ fontSize: 16 }} />;
    const IconComponent = getDbIcon(connection.dbType);
    return IconComponent ? <IconComponent /> : <FileExcelOutlined style={{ fontSize: 16 }} />;
  }
  const IconComponent = getDbIcon(connection.dbType);
  return IconComponent ? <IconComponent /> : <DatabaseOutlined style={{ fontSize: 16 }} />;
};

const OutputNodeChat = ({
  node,
  nodes,
  edges,
  initialConfig,
  onSave,
  onCancel,
  onDirtyChange,
  executeOutput,
  executingInd,
  executing = false,
}) => {
  const initialized = useRef(false);

  const [loading, setLoading] = useState(true);
  const [sourceError, setSourceError] = useState(null);

  // Source node (output requires exactly 1 input)
  const [sourceNode, setSourceNode] = useState(null);
  const [sourceConnection, setSourceConnection] = useState(null);
  const [sourceTableSchema, setSourceTableSchema] = useState(null);

  // Destinations that can receive output
  const [availableConnections, setAvailableConnections] = useState([]);
  const [pluginManager, setPluginManager] = useState(null);

  const saved = initialConfig?.outputSettings || null;
  const [outputSettings, setOutputSettings] = useState({
    outputType: saved?.outputType || 'local',
    format: saved?.format || null,
    savePath: saved?.savePath || null,
    connectionId: saved?.connectionId || null,
    tableName: saved?.tableName || null,
    // Excel only. An output node has exactly one input, so it writes exactly
    // one sheet — pointing several nodes at the same workbook with different
    // sheet names is how a multi-sheet file gets built.
    sheetName: saved?.sheetName || null,
  });

  const [dirty, setDirty] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [executionError, setExecutionError] = useState(null);

  const [cloudStorageBrowserOpen, setCloudStorageBrowserOpen] = useState(false);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  // The one funnel every control in this form writes through, and so the one
  // place `dirty` is raised — which is what puts the footer action on screen.
  const patch = useCallback((next) => {
    setDirty(true);
    setExecutionError(null);
    setOutputSettings((prev) => ({ ...prev, ...next }));
  }, []);

  // ── Detect the source node and load destinations ─────────────────────────

  const detectSourceNode = useCallback(async () => {
    const connectedEdges = edges.filter((e) => e.target === node.id);
    if (connectedEdges.length === 0) {
      setSourceError('An output node requires a connected data source. Connect a source, then reopen this node.');
      return;
    }
    if (connectedEdges.length > 1) {
      setSourceError('An output node can only have one connected source. Remove the extra connections.');
      return;
    }

    const source = nodes.find((n) => n.id === connectedEdges[0].source);
    if (!source || !source.data?.config) {
      setSourceError(`Source node "${source?.data?.label || 'upstream'}" is not configured. Configure the source first.`);
      return;
    }

    const sourceConfig = source.data.config;
    const isDataSource = sourceConfig.nodeType === 'datasource';

    const connection = {
      id: isDataSource ? sourceConfig.sourceConnectionId : sourceConfig.targetConnectionId,
      name: isDataSource ? sourceConfig.sourceConnectionName : sourceConfig.targetConnectionName,
      connectionType: isDataSource
        ? (sourceConfig.sourceConnectionType || 'database')
        : (sourceConfig.targetConnectionType || 'database'),
      dbType: isDataSource ? sourceConfig.sourceDbType : sourceConfig.targetDbType,
      dbConfig: isDataSource ? (sourceConfig.sourceDbConfig || {}) : (sourceConfig.targetDbConfig || {}),
      localPath: isDataSource ? sourceConfig.sourceLocalPath : sourceConfig.targetLocalPath,
      fileInfo: sourceConfig.fileInfo,
    };

    const savedSchema = isDataSource ? sourceConfig.sourceTableSchema : sourceConfig.targetTableSchema;

    let schema;
    if (savedSchema) {
      schema = {
        sourceNodeId: source.id,
        sourceNodeLabel: source.data.label,
        tableName: (isDataSource ? sourceConfig.sourceTableName : sourceConfig.targetTableName)
          || (isDataSource ? sourceConfig.sourceCollection : sourceConfig.targetCollection)
          || savedSchema.tableName,
        columns: savedSchema.columns,
        sampleData: savedSchema.sampleData,
        query: isDataSource ? sourceConfig.sourceSql : sourceConfig.targetSql,
        sheetName: savedSchema.sheetName,
      };
    } else {
      schema = await loadSourceTableSchema(source, connection);
      if (schema) {
        schema.sourceNodeId = source.id;
        schema.sourceNodeLabel = source.data.label;
      }
    }

    if (!schema) {
      setSourceError(`Failed to load the schema for source "${source.data.label}".`);
      return;
    }

    setSourceNode(source);
    setSourceConnection(connection);
    setSourceTableSchema(schema);
    setSourceError(null);
  }, [edges, nodes, node.id]);

  const loadSourceTableSchema = async (source, connection) => {
    if (!window.electronAPI?.dbConnect && connection.connectionType === 'database') {
      console.warn('Database API not available');
      return null;
    }
    try {
      const sourceConfig = source?.data?.config || {};
      const isNoSQL = connection.dbType === 'mongodb' || connection.dbType === 'nedb';

      let tableName = null;
      let tableSchema = null;
      let localPath = null;
      let queryConnection = connection;

      if (isNoSQL) {
        tableName = sourceConfig.targetCollection || sourceConfig.sourceCollection || sourceConfig.table;
        localPath = sourceConfig.targetLocalPath || sourceConfig.sourceLocalPath;
        if (connection.dbType === 'nedb') queryConnection = { ...connection, dbType: 'mongodb' };
      } else {
        tableSchema = sourceConfig.targetSchema || sourceConfig.sourceSchema || connection.dbConfig?.schema;
        tableName = sourceConfig.targetTableName || sourceConfig.sourceTableName || sourceConfig.table;
      }

      if (!tableName && !localPath) {
        console.warn('Could not determine table name or local path from source config');
        return null;
      }

      return await loadTableSchema({ connection: queryConnection, tableName, tableSchema, localPath, limit: 5 });
    } catch (error) {
      console.error('Failed to load source schema:', error);
      return null;
    }
  };

  const loadDestinations = useCallback(async () => {
    const allConnections = await connectionsDb.getAll();

    const pluginsMap = new Map();
    if (window.electronAPI?.dbConnect?.listPlugins) {
      try {
        const pluginsResult = await window.electronAPI.dbConnect.listPlugins();
        if (pluginsResult.success && pluginsResult.connectors) {
          pluginsResult.connectors.forEach((plugin) => pluginsMap.set(plugin.id, plugin));
          setPluginManager({
            getConnector: (dbType) => pluginsResult.connectors.find((c) => c.id === dbType) || null,
          });
        }
      } catch (error) {
        console.error('Failed to load plugins:', error);
      }
    }

    const enriched = allConnections.map((conn) => {
      const plugin = pluginsMap.get(conn.dbType);
      return { ...conn, dbCategory: plugin?.dbCategory || null, storageType: plugin?.storageType || null };
    });

    // Only databases, vector stores and cloud storage can receive output. A
    // REST API is read-only as far as the output node is concerned, and it can
    // carry connectionType 'database', so exclude it explicitly.
    const destinations = enriched
      .filter((conn) => conn.dbCategory !== 'API' && conn.dbType !== 'rest-api')
      .filter((conn) => conn.connectionType === 'database'
        || conn.dbCategory === 'CloudStorage'
        || conn.dbCategory === 'Vector')
      .map((conn) => {
        const group = categorizeConnection(conn);
        const isCloudStorage = conn.dbCategory === 'CloudStorage';
        const isVector = conn.dbCategory === 'Vector';
        return {
          id: conn.id,
          name: conn.name,
          meta: isCloudStorage
            ? `Upload to ${conn.name} (${conn.dbType})`
            : isVector
              ? `Insert vectors into ${conn.name} (${conn.dbType})`
              : `Insert into ${conn.name} (${conn.dbType})`,
          connection: conn,
          icon: getConnectionIcon(conn),
          group,
        };
      });

    setAvailableConnections(destinations);
    return destinations;
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    (async () => {
      setLoading(true);
      await detectSourceNode();
      const destinations = await loadDestinations();

      // Repair a table name pre-quoted by an older build.
      const savedTable = saved?.tableName;
      if (saved?.outputType === 'connection' && savedTable) {
        const dest = destinations.find((d) => d.id === saved.connectionId);
        if (dest && dest.group !== 'Cloud Storage') {
          const fixed = normalizeSavedTableName(savedTable, dest.connection);
          if (fixed !== savedTable) {
            setOutputSettings((prev) => ({ ...prev, tableName: fixed }));
          }
        }
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectSourceNode, loadDestinations]);

  // ── Derived selection state ──────────────────────────────────────────────

  const selectedDestination = useMemo(
    () => availableConnections.find((c) => c.id === outputSettings.connectionId) || null,
    [availableConnections, outputSettings.connectionId],
  );

  const destKind = useMemo(() => {
    if (!selectedDestination) return null;
    const group = selectedDestination.group;
    if (group === 'Cloud Storage') return 'cloud';
    if (group === 'Vector') return 'vector';
    return 'database';
  }, [selectedDestination]);

  const grouped = useMemo(() => {
    const buckets = new Map();
    availableConnections.forEach((c) => {
      if (!buckets.has(c.group)) buckets.set(c.group, []);
      buckets.get(c.group).push(c);
    });
    buckets.forEach((list) => list.sort((a, b) => String(a.name).localeCompare(
      String(b.name), undefined, { sensitivity: 'base', numeric: true },
    )));
    return GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => [g, buckets.get(g)]);
  }, [availableConnections]);

  // Categories collapse so a long destination list stays navigable. Open the
  // group holding the current selection, else the first one.
  const [openGroups, setOpenGroups] = useState({});
  const groupsSeeded = useRef(false);
  useEffect(() => {
    if (groupsSeeded.current || loading || grouped.length === 0) return;
    groupsSeeded.current = true;
    const selectedGroup = availableConnections.find((c) => c.id === outputSettings.connectionId)?.group;
    setOpenGroups({ [selectedGroup || grouped[0][0]]: true });
  }, [grouped, availableConnections, outputSettings.connectionId, loading]);

  const toggleGroup = (group) => setOpenGroups((prev) => ({ ...prev, [group]: !prev[group] }));

  const dbType = selectedDestination?.connection?.dbType;

  // ── Validation ───────────────────────────────────────────────────────────

  const missing = useMemo(() => {
    const out = {};
    if (outputSettings.outputType === 'local') {
      if (!outputSettings.format) out.format = true;
      if (!outputSettings.savePath) out.savePath = true;
      // A workbook needs a tab to write to, and the user can clear the field.
      if (outputSettings.format === 'excel' && !String(outputSettings.sheetName || '').trim()) {
        out.sheetName = true;
      }
    } else {
      if (!outputSettings.connectionId) out.connectionId = true;
      else if (!outputSettings.tableName) out.tableName = true;
    }
    return out;
  }, [outputSettings]);

  const missingCount = Object.keys(missing).length;
  const invalid = (key) => attempted && !!missing[key];

  // Cloud destinations can't be saved until a path has been browsed to.
  const needsCloudPick = outputSettings.outputType === 'connection' && destKind === 'cloud';
  const cloudBlocked = needsCloudPick && !outputSettings.tableName;

  // `executing` is panel-level (the header Run button shares it); `submitting`
  // is this form's own click guard.
  const running = executing || submitting;

  const gateMessage = running
    ? 'Running the output…'
    : cloudBlocked
    ? 'Pick an upload path to enable Save'
    : executionError
      ? executionError
      : attempted && missingCount > 0
        ? `${missingCount} field${missingCount === 1 ? '' : 's'} still needed`
        : null;

  // ── Actions ──────────────────────────────────────────────────────────────

  // What an Excel sheet is called when the user hasn't said: the table this
  // node is writing. Two output nodes on one workbook then land on different
  // tabs by default instead of overwriting each other.
  const defaultSheetName = useCallback(
    () => sanitizeSheetName(sourceTableSchema?.tableName || sourceNode?.data?.label),
    [sourceTableSchema, sourceNode],
  );

  // Fill the sheet name in once the source is known — for a node saved before
  // this field existed, and for one whose format was set before the source
  // finished loading.
  useEffect(() => {
    if (outputSettings.outputType !== 'local' || outputSettings.format !== 'excel') return;
    if (outputSettings.sheetName) return;
    if (!sourceTableSchema && !sourceNode) return;
    setOutputSettings((prev) => (prev.sheetName ? prev : { ...prev, sheetName: defaultSheetName() }));
  }, [outputSettings.outputType, outputSettings.format, outputSettings.sheetName,
    sourceTableSchema, sourceNode, defaultSheetName]);

  const changeOutputType = (value) => {
    // Switching sides drops whatever the other side had picked.
    patch({ outputType: value, format: null, savePath: null, connectionId: null, tableName: null, sheetName: null });
    setAttempted(false);
  };

  const changeDestination = (conn) => {
    patch({ connectionId: conn.id, tableName: null });
    setAttempted(false);
  };

  const browseSavePath = async () => {
    if (!outputSettings.format) {
      antdMessage.warning('Choose an output format first.');
      return;
    }
    const fileExtension = outputSettings.format === 'excel' ? 'xlsx' : outputSettings.format;
    const defaultFileName = `output_${node.id.slice(0, 8)}.${fileExtension}`;
    try {
      const result = await window.electronAPI.selectSavePath(defaultFileName, fileExtension);
      if (result.canceled) return;
      patch({ savePath: result.filePath });
    } catch (error) {
      console.error('Error selecting save path:', error);
      antdMessage.error('Failed to open the save dialog.');
    }
  };

  const handleCloudStoragePathSelect = (pathInfo) => {
    setCloudStorageBrowserOpen(false);
    patch({ tableName: pathInfo.fullPath });
  };

  const buildConfig = (finalSettings) => {
    if (!sourceNode || !sourceConnection) return {};
    return {
      nodeType: 'output',

      sourceNodeId: sourceNode.id,
      sourceNodeLabel: sourceNode.data?.label,
      sourceConnectionId: sourceConnection.id,
      sourceConnectionName: sourceConnection.name,
      sourceConnectionType: sourceConnection.connectionType,
      sourceDbType: sourceConnection.dbType,
      sourceDbConfig: sourceConnection.dbConfig,
      sourceTableSchema,
      sourceTableName: sourceTableSchema?.tableName,
      sourceCollection: sourceTableSchema?.tableName,
      sourceLocalPath: sourceConnection.localPath,

      outputSettings: finalSettings,
    };
  };

  // Run the output, then persist — the footer action is "Run & Save".
  const handleSave = async () => {
    setAttempted(true);
    if (missingCount > 0 || cloudBlocked) return;
    if (submitting) return; // guard against a double click racing the first run

    setExecutionError(null);
    setSubmitting(true);

    // The table name goes through as the user typed it. insertToConnection
    // quotes and schema-qualifies it itself, and hands the RAW name to
    // batchInsert — pre-quoting here produced `db`.`tbl` which then got
    // re-qualified, so CREATE TABLE failed silently and the insert reported
    // "table doesn't exist".
    const finalSettings = outputSettings;

    executingInd(true);
    try {
      const result = await executeOutput({
        sourceConnection,
        sourceTableSchema,
        outputSettings: finalSettings,
        onSuccess: (res) => {
          antdMessage.success(res.message || 'Output complete.');
          if (res.filePath) antdMessage.info(`File saved at: ${res.filePath}`);
        },
        onError: (err) => {
          setExecutionError(`Output failed: ${err.error || err.message}`);
        },
      });

      if (!result.success) return;

      onSave(buildConfig(finalSettings), []);
      // Ran and saved — nothing left to do until a setting changes, and
      // clearing `dirty` is what takes the footer action back off screen.
      setDirty(false);
      setAttempted(false);
    } finally {
      executingInd(false);
      setSubmitting(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <FormScope>
        <FormBody><EmptyState>Loading the connected source…</EmptyState></FormBody>
      </FormScope>
    );
  }

  if (sourceError) {
    return (
      <FormScope>
        <FormBody>
          <Card label="Source"><Note>{sourceError}</Note></Card>
        </FormBody>
      </FormScope>
    );
  }

  const isLocal = outputSettings.outputType === 'local';

  return (
    <FormScope>
      <FormBody>
        <Card label="Output">
          <Fields>
            <Field
              label="Where would you like to output the data?"
              hint="Export to a local file, or insert into a saved connection."
            >
              <Segmented
                value={outputSettings.outputType}
                options={[
                  { label: 'Local Environment', value: 'local' },
                  { label: 'Connection', value: 'connection' },
                ]}
                onChange={changeOutputType}
              />
            </Field>
            <Note>
              Source: <strong>{sourceNode?.data?.label || sourceTableSchema?.tableName}</strong>
              {' '}— an output node takes exactly one input.
            </Note>
          </Fields>
        </Card>

        {isLocal && (
          <Card label="Local file">
            <Fields>
              <Field label="Output format" required invalid={invalid('format')}>
                <SelectInput
                  value={outputSettings.format ?? ''}
                  placeholder="Select a format…"
                  options={FORMAT_OPTIONS}
                  // Changing the format invalidates a path with the old extension.
                  // A sheet name means nothing outside a workbook.
                  onChange={(v) => patch({
                    format: v,
                    savePath: null,
                    sheetName: v === 'excel' ? (outputSettings.sheetName || defaultSheetName()) : null,
                  })}
                />
              </Field>
              {outputSettings.format === 'excel' && (
                <Field
                  label="Sheet name"
                  required
                  invalid={invalid('sheetName')}
                  hint={<>The tab this output writes. An existing workbook keeps its other sheets, so a second output node pointed at the same file adds another sheet rather than replacing it.</>}
                >
                  <TextInput
                    value={outputSettings.sheetName ?? ''}
                    placeholder={defaultSheetName()}
                    onChange={(v) => patch({ sheetName: v })}
                  />
                </Field>
              )}
              <Field
                label="Save to"
                required
                invalid={invalid('savePath')}
                hint={<>Opens the native save dialog. Defaults to <code>output_{'{node}'}.{'{ext}'}</code>.</>}
              >
                <PathPicker
                  value={outputSettings.savePath}
                  placeholder="Choose where to write the file…"
                  onChange={(v) => patch({ savePath: v || null })}
                  onBrowse={browseSavePath}
                  browseTitle="Choose save location"
                />
              </Field>
            </Fields>
          </Card>
        )}

        {!isLocal && (
          <Card label="Destination connection">
            {availableConnections.length === 0 ? (
              <EmptyState>
                No database, vector or cloud-storage connection is available. Create one from the Connections tab.
              </EmptyState>
            ) : (
              <>
                <ConnList grouped>
                  {grouped.map(([group, conns]) => (
                    <React.Fragment key={group}>
                      <ConnGroupToggle
                        label={group}
                        color={GROUP_COLOR[group]}
                        count={conns.length}
                        open={!!openGroups[group]}
                        onToggle={() => toggleGroup(group)}
                      />
                      {openGroups[group] && conns.map((c) => (
                        <ConnRow
                          key={c.id}
                          icon={c.icon}
                          name={c.name}
                          meta={c.meta}
                          selected={c.id === outputSettings.connectionId}
                          onClick={() => changeDestination(c)}
                        />
                      ))}
                    </React.Fragment>
                  ))}
                </ConnList>
                <div className="tlx-hint" style={{ marginTop: 8 }}>
                  Only database, vector and cloud-storage connections can receive output.
                </div>
              </>
            )}
          </Card>
        )}

        {!isLocal && destKind === 'database' && (
          <Card label="Target table">
            <Fields>
              <Field
                label="What table should the data be inserted into?"
                required
                invalid={invalid('tableName')}
                hint={
                  dbType === 'bigquery'
                    ? <>BigQuery expects <code>dataset.table_name</code>.</>
                    : dbType === 'snowflake'
                      ? <>Snowflake accepts <code>schema.table_name</code> or a bare name.</>
                      : 'Quoted and schema-qualified for you when the output runs. Created if it does not exist.'
                }
              >
                <TextInput
                  mono
                  value={outputSettings.tableName}
                  placeholder={dbType === 'bigquery' ? 'dataset.table_name' : 'orders_enriched'}
                  onChange={(v) => patch({ tableName: v })}
                />
              </Field>
            </Fields>
          </Card>
        )}

        {!isLocal && destKind === 'vector' && (
          <Card label="Target index">
            <Fields>
              <Field
                label="What table should the vectors be inserted into?"
                required
                invalid={invalid('tableName')}
                hint={dbType === 'pinecone'
                  ? <>Pinecone takes <code>index-name</code> or <code>index-name/namespace</code>.</>
                  : null}
              >
                <TextInput
                  mono
                  value={outputSettings.tableName}
                  placeholder={dbType === 'pinecone' ? 'index-name or index-name/namespace' : 'Enter table name…'}
                  onChange={(v) => patch({ tableName: v })}
                />
              </Field>
            </Fields>
          </Card>
        )}

        {!isLocal && destKind === 'cloud' && (
          <Card label="Upload path">
            <Handoff
              color={FORM_ACCENT.source}
              icon={<IconFolder color={FORM_ACCENT.source} size={14} />}
              title="Choose where to upload"
            >
              <HandoffBody>
                Browse the bucket and pick the container and object path the results are written to.
                Save stays disabled until a path is chosen.
              </HandoffBody>
              {outputSettings.tableName ? (
                <Picked>Uploading to <code>{outputSettings.tableName}</code></Picked>
              ) : null}
              <CloudButton
                onClick={() => setCloudStorageBrowserOpen(true)}
                disabled={!pluginManager}
              >
                {outputSettings.tableName ? 'Change location' : 'Open storage browser'}
              </CloudButton>
            </Handoff>
          </Card>
        )}
      </FormBody>

      <FormFooter
        error={gateMessage}
        onCancel={onCancel}
        cancelDisabled={running}
        onSave={handleSave}
        saveLabel={running ? 'Running…' : 'Run & Save Configuration'}
        // Nothing edited, nothing to run or save — so the button stays disabled
        // until something changes. This covers BOTH the moment the form opens
        // and the moment a run finishes (which clears `dirty`), so a successful
        // run cannot be repeated by accident on a config that has not moved.
        saveDisabled={running || cloudBlocked || !dirty}
        saveDisabledReason={running
          ? 'The output is running — wait for it to finish.'
          : cloudBlocked
            ? 'Pick an upload path in the storage browser first.'
            : !dirty
              ? 'Nothing has changed yet. Edit a setting to run and save again.'
              : undefined}
      />

      {cloudStorageBrowserOpen && selectedDestination?.connection && pluginManager && (
        <CloudStorageBrowser
          open={cloudStorageBrowserOpen}
          onClose={() => setCloudStorageBrowserOpen(false)}
          connection={selectedDestination.connection}
          onFileSelect={handleCloudStoragePathSelect}
          pluginManager={pluginManager}
          mode="output"
          sourceDbType={sourceConnection?.dbType}
        />
      )}
    </FormScope>
  );
};

export default OutputNodeChat;
