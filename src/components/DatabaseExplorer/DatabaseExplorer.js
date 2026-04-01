import React, { useState, useCallback } from 'react';
import {
  Layout, Tree, Button, Spin, Alert, Typography, Table, Tag, Tooltip,
  Space, Divider, Empty, message, Collapse,
} from 'antd';
import {
  DatabaseOutlined, TableOutlined, ReloadOutlined, PlayCircleOutlined,
  KeyOutlined, ColumnHeightOutlined,
} from '@ant-design/icons';
import Editor from '@monaco-editor/react';

const { Sider, Content } = Layout;
const { Text, Title } = Typography;

const DB_COLORS = {
  postgres: '#336791',
  mysql:    '#e48b00',
  mssql:    '#0078d4',
  mongodb:  '#00a550',
  generic:  '#6c757d',
};

/**
 * DatabaseExplorer
 *
 * Props:
 *   connection — a connection object from connectionsDb / ConnectionsTab
 *                { name, dbType, dbConfig }
 *   onClose    — called when user dismisses the explorer
 */
const DatabaseExplorer = ({ connection, onClose }) => {
  const [treeData, setTreeData]         = useState([]);
  const [loadingTree, setLoadingTree]   = useState(false);
  const [treeError, setTreeError]       = useState(null);
  const [selectedTable, setSelectedTable] = useState(null);
  const [columns, setColumns]           = useState([]);
  const [loadingCols, setLoadingCols]   = useState(false);
  const [query, setQuery]               = useState('');
  const [queryResult, setQueryResult]   = useState(null);
  const [runningQuery, setRunningQuery] = useState(false);
  const [queryError, setQueryError]     = useState(null);
  const [expandedKeys, setExpandedKeys] = useState([]);
  const [columnPanelOpen, setColumnPanelOpen] = useState(true);

  const dbType = connection.dbType;
  const config = connection.dbConfig;
  const color  = DB_COLORS[dbType] || '#6c757d';

  const isElectron = Boolean(window.electronAPI?.dbConnect);

  // ── load schema tree ──────────────────────────────────────────────────────

  const loadTables = useCallback(async () => {
    if (!isElectron) {
      setTreeError('Direct connections require the Electron desktop app.');
      return;
    }
    setLoadingTree(true);
    setTreeError(null);
    setSelectedTable(null);
    setColumns([]);
    setQueryResult(null);

    const result = await window.electronAPI.dbConnect.getTables(dbType, config, connection.id);
    setLoadingTree(false);

    if (!result.success) {
      setTreeError(result.message || 'Failed to load tables.');
      return;
    }

    // Group by schema
    const schemaMap = {};
    result.tables.forEach(t => {
      if (!schemaMap[t.schema]) schemaMap[t.schema] = [];
      schemaMap[t.schema].push(t);
    });

    // Sort schemas alphabetically and tables within each schema
    const nodes = Object.entries(schemaMap)
      .sort(([schemaA], [schemaB]) => schemaA.localeCompare(schemaB))
      .map(([schema, tables]) => ({
        key: `schema:${schema}`,
        title: (
          <Space size={4}>
            <DatabaseOutlined style={{ color }} />
            <Text strong style={{ fontSize: 13 }}>{schema}</Text>
            <Tag color="default" style={{ fontSize: 11, marginLeft: 4 }}>{tables.length}</Tag>
          </Space>
        ),
        children: tables
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(t => ({
            key: `table:${schema}:${t.name}`,
            title: (
              <Space size={4}>
                <TableOutlined style={{ color: '#8c8c8c' }} />
                <Text style={{ fontSize: 13 }}>{t.name}</Text>
                {t.type === 'VIEW' || t.type === 'COLLECTION' ? (
                  <Tag color="geekblue" style={{ fontSize: 10 }}>{t.type}</Tag>
                ) : null}
              </Space>
            ),
            isLeaf: true,
            _schema: schema,
            _table: t.name,
          })),
      }));

    setTreeData(nodes);

    // Auto-expand if single schema
    if (nodes.length === 1) {
      setExpandedKeys([nodes[0].key]);
    } else {
      setExpandedKeys([]); // Collapse all by default when multiple schemas
    }
  }, [dbType, config, color, isElectron]);

  // ── select table → load columns ──────────────────────────────────────────

  const handleSelectNode = async (_, { node }) => {
    if (!node._table) return; // schema node
    setSelectedTable({ schema: node._schema, name: node._table });
    setColumns([]);
    setQueryResult(null);
    setQueryError(null);
    setLoadingCols(true);

    // Set a default query when a table is selected
    if (dbType === 'mongodb') {
      setQuery(JSON.stringify({ collection: node._table, filter: {}, limit: 100 }, null, 2));
    } else {
      // Get properly quoted table name
      const quotedResult = await window.electronAPI.dbConnect.quoteIdentifier(
        dbType,
        node._table,
        node._schema,
        config,
        connection.id
      );
      const fullTableName = quotedResult.success ? quotedResult.quotedIdentifier : node._table;

      // Use database-specific preview query syntax
      const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
        dbType,
        fullTableName,
        100
      );
      const previewQuery = previewResult.success ? previewResult.previewQuery : `SELECT *\nFROM ${fullTableName}\nLIMIT 100;`;
      setQuery(previewQuery);
    }

    const result = await window.electronAPI.dbConnect.getColumns(
      dbType, config, node._schema, node._table, connection.id
    );
    setLoadingCols(false);

    if (result.success) {
      setColumns(result.columns);
    } else {
      message.warning('Could not load column info: ' + result.message);
    }
  };

  // ── run query ─────────────────────────────────────────────────────────────

  const handleRunQuery = async () => {
    if (!query.trim()) return;
    setRunningQuery(true);
    setQueryError(null);
    setQueryResult(null);

    const result = await window.electronAPI.dbConnect.runQuery(dbType, config, {query}, connection.id);
    setRunningQuery(false);

    if (!result.success) {
      setQueryError(result.message || 'Query failed.');
      return;
    }
    setQueryResult(result);
  };

  // ── column table definition ───────────────────────────────────────────────

  const columnDefs = [
    {
      title: 'Column',
      dataIndex: 'name',
      key: 'name',
      render: (name, rec) => (
        <Space size={4}>
          {rec.isPrimary ? (
            <Tooltip title="Primary Key">
              <KeyOutlined style={{ color: '#faad14', fontSize: 12 }} />
            </Tooltip>
          ) : (
            <ColumnHeightOutlined style={{ color: '#bfbfbf', fontSize: 12 }} />
          )}
          <Text style={{ fontSize: 13 }}>{name}</Text>
        </Space>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      render: t => <Tag style={{ fontSize: 11 }}>{t}</Tag>,
    },
    {
      title: 'Nullable',
      dataIndex: 'nullable',
      key: 'nullable',
      width: 80,
      render: v => (
        <Text type={v === 'YES' || v === 1 || v === true ? 'secondary' : undefined}
              style={{ fontSize: 12 }}>
          {v === 'YES' || v === 1 || v === true ? 'yes' : 'no'}
        </Text>
      ),
    },
  ];

  // ── query result table ────────────────────────────────────────────────────

  const resultColumns = queryResult?.columns?.map((col, i) => ({
    title: col,
    dataIndex: col,
    key: `${col}_${i}`,
    ellipsis: true,
    render: v => v === null ? <Text type="secondary" style={{ fontSize: 12 }}>NULL</Text>
                             : <Text style={{ fontSize: 12 }}>{String(v)}</Text>,
  })) || [];

  const resultRows = queryResult?.rows?.map((row, i) => ({ ...row, _key: i })) || [];

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <Layout style={{ height: '100%', minHeight: 520, background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8 }}>
      {/* Left: schema tree */}
      <Sider
        width={260}
        style={{ background: '#fafafa', borderRight: '1px solid #f0f0f0', borderRadius: '8px 0 0 8px', padding: '12px 0' }}
      >
        <div style={{ padding: '0 12px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space size={6}>
            <div style={{
              width: 28, height: 28, borderRadius: 6, background: color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <DatabaseOutlined style={{ color: '#fff', fontSize: 14 }} />
            </div>
            <Text strong style={{ fontSize: 13 }} ellipsis>{connection.name}</Text>
          </Space>
          <Tooltip title="Refresh tables">
            <Button
              type="text" size="small"
              icon={<ReloadOutlined spin={loadingTree} />}
              onClick={loadTables}
              disabled={!isElectron}
            />
          </Tooltip>
        </div>

        <Divider style={{ margin: '0 0 8px' }} />

        {!isElectron && (
          <div style={{ padding: '0 12px' }}>
            <Alert type="warning" showIcon message="Desktop app required for direct connections." />
          </div>
        )}

        {treeError && (
          <div style={{ padding: '0 12px' }}>
            <Alert type="error" showIcon message={treeError} style={{ fontSize: 12 }} />
          </div>
        )}

        {loadingTree ? (
          <div style={{ textAlign: 'center', paddingTop: 32 }}>
            <Spin />
          </div>
        ) : treeData.length === 0 && !treeError ? (
          <div style={{ textAlign: 'center', paddingTop: 24 }}>
            {isElectron ? (
              <Button type="primary" icon={<DatabaseOutlined />} onClick={loadTables} size="small">
                Load Schema
              </Button>
            ) : null}
          </div>
        ) : (
          <div style={{ overflowY: 'auto', overflowX: 'hidden', maxHeight: 'calc(100% - 80px)', paddingRight: 4 }}>
            <Tree
              treeData={treeData}
              expandedKeys={expandedKeys}
              onExpand={setExpandedKeys}
              onSelect={handleSelectNode}
              style={{ background: 'transparent', padding: '0 4px' }}
              blockNode
            />
          </div>
        )}
      </Sider>

      {/* Right: columns + query runner */}
      <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Column info panel */}
        <Collapse
          activeKey={columnPanelOpen ? ['columnPanel'] : []}
          onChange={(keys) => setColumnPanelOpen(keys.includes('columnPanel'))}
          style={{ borderBottom: '1px solid #f0f0f0' }}
          expandIconPosition="end"
        >
          <Collapse.Panel
            header={
              <Space size={6}>
                <ColumnHeightOutlined />
                <Text strong style={{ fontSize: 13 }}>
                  {selectedTable
                    ? `${selectedTable.schema ? `${selectedTable.schema}.` : ''}${selectedTable.name}`
                    : 'Table Columns'}
                </Text>
                {columns.length > 0 && (
                  <Tag color="default" style={{ fontSize: 11 }}>{columns.length} columns</Tag>
                )}
              </Space>
            }
            key="columnPanel"
          >
            <div style={{ maxHeight: 220, overflow: 'auto' }}>
              {selectedTable ? (
                <>
                  {loadingCols ? (
                    <div style={{ textAlign: 'center', padding: 20 }}>
                      <Spin size="small" />
                    </div>
                  ) : columns.length > 0 ? (
                    <Table
                      dataSource={columns}
                      columns={columnDefs}
                      rowKey="name"
                      size="small"
                      pagination={false}
                    />
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>No column info available.</Text>
                  )}
                </>
              ) : (
                <Empty description="Select a table to inspect columns" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: '16px 0' }} />
              )}
            </div>
          </Collapse.Panel>
        </Collapse>

        {/* Query runner */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '12px 16px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text strong style={{ fontSize: 13 }}>
              {dbType === 'mongodb' ? 'Query (JSON)' : 'SQL Query'}
            </Text>
            <Button
              type="primary"
              size="small"
              icon={<PlayCircleOutlined />}
              loading={runningQuery}
              onClick={handleRunQuery}
              disabled={!query.trim() || !isElectron}
            >
              Run
            </Button>
          </div>

          <div style={{ border: '1px solid #d9d9d9', borderRadius: 4, marginBottom: 10, overflow: 'hidden' }}>
            <Editor
              height="150px"
              language={dbType === 'mongodb' ? 'json' : 'sql'}
              value={query}
              onChange={(value) => setQuery(value || '')}
              theme="vs"
              options={{
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: 13,
                lineNumbers: 'on',
                renderLineHighlight: 'line',
                scrollbar: {
                  vertical: 'auto',
                  horizontal: 'auto',
                  verticalScrollbarSize: 10,
                  horizontalScrollbarSize: 10
                },
                padding: { top: 8, bottom: 8 },
                wordWrap: 'on',
                automaticLayout: true,
              }}
              onMount={(editor) => {
                // Add Ctrl/Cmd+Enter to run query
                editor.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.Enter, () => {
                  handleRunQuery();
                });
              }}
            />
          </div>

          {queryError && (
            <Alert type="error" showIcon message={queryError} style={{ marginBottom: 8, fontSize: 12 }} />
          )}

          {queryResult && (
            <div style={{ flex: 1, overflow: 'auto' }}>
              <div style={{ marginBottom: 6 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {queryResult.rowCount ?? resultRows.length} row(s) returned
                </Text>
              </div>
              {queryResult.json || dbType === 'mongodb' ? (
                <pre style={{
                  backgroundColor: '#f5f5f5',
                  padding: '16px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  lineHeight: '1.6',
                  margin: 0,
                  overflow: 'auto',
                  maxHeight: 320
                }}>
                  {JSON.stringify(queryResult.rows, null, 2)}
                </pre>
              ) : (
                <Table
                  dataSource={resultRows}
                  columns={resultColumns}
                  rowKey="_key"
                  size="small"
                  pagination={{ pageSize: 50, size: 'small', showSizeChanger: false }}
                  scroll={{ x: 'max-content', y: 280 }}
                />
              )}
            </div>
          )}
        </div>
      </Content>
    </Layout>
  );
};

export default DatabaseExplorer;
