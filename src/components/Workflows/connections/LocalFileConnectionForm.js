import React, { useState } from 'react';
import { Form, Input, Button, Space, message, Upload, Card, Typography, Progress } from 'antd';
import {
  InboxOutlined,
  FileTextOutlined,
  DatabaseOutlined,
  CheckCircleOutlined,
  LoadingOutlined
} from '@ant-design/icons';
import { ReactComponent as ParquetIcon } from '../../ConnectorImages/Parquet.svg';
import { ReactComponent as AvroIcon } from '../../ConnectorImages/Avro.svg';

const { Dragger } = Upload;
const { TextArea } = Input;
const { Text, Title } = Typography;

// SVG Icon wrapper with consistent sizing
const DbIcon = ({ Icon, bg }) => (
  <div style={{
    width: 48, height: 48, borderRadius: 10,
    background: bg, display: 'flex', alignItems: 'center',
    justifyContent: 'center', padding: 8,
  }}>
    <Icon style={{ width: '100%', height: '100%', fill: '#fff' }} />
  </div>
);

const LocalFileConnectionForm = ({
  fileType, // 'sqlite', 'nedb', 'lancedb', 'json', 'spreadsheet', 'parquet', 'avro'
  onSave,
  onCancel,
  editingConnection
}) => {
  const [form] = Form.useForm();
  const [filePath, setFilePath] = useState(editingConnection?.fileInfo?.filePath || '');
  const [fileName, setFileName] = useState(editingConnection?.fileInfo?.originalName || '');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // Initialize form with editing data
  React.useEffect(() => {
    if (editingConnection) {
      form.setFieldsValue({
        name: editingConnection.name,
        description: editingConnection.description,
      });
      setFilePath(editingConnection.fileInfo?.filePath || '');
      setFileName(editingConnection.fileInfo?.originalName || '');
    }
  }, [editingConnection, form]);

  const handleBrowseFile = async () => {
    // Prevent opening dialog if already open
    if (isDialogOpen || !window.electronAPI?.openFileDialog) {
      if (!window.electronAPI?.openFileDialog) {
        message.error('File browser requires desktop app');
      }
      return;
    }

    setIsDialogOpen(true);

    // Define file extensions based on type
    const filters = {
      sqlite: [{ name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] }],
      nedb: [{ name: 'NeDB Database', extensions: ['db', 'nedb'] }],
      lancedb: [{ name: 'LanceDB Directory', extensions: ['lance'] }],
      json: [{ name: 'JSON Files', extensions: ['json'] }],
      spreadsheet: [
        { name: 'Spreadsheet Files', extensions: ['csv', 'xlsx', 'xls'] },
        { name: 'CSV Files', extensions: ['csv'] },
        { name: 'Excel Files', extensions: ['xlsx', 'xls'] }
      ],
      parquet: [{ name: 'Parquet Files', extensions: ['parquet'] }],
      avro: [{ name: 'Avro Files', extensions: ['avro'] }]
    };

    try {
      // For LanceDB, open directory instead of file
      const dialogOptions = fileType === 'lancedb'
        ? { properties: ['openDirectory'] }
        : { properties: ['openFile'], filters: filters[fileType] || [] };

      const result = await window.electronAPI.openFileDialog(dialogOptions);

      if (!result.canceled && result.filePaths?.length > 0) {
        const selectedPath = result.filePaths[0];
        const selectedFileName = selectedPath.split(/[\\/]/).pop();

        // For LanceDB (directory), skip file extension validation
        if (fileType !== 'lancedb') {
          // Validate file extension for file-based types
          if (!isValidFileType(selectedFileName)) {
            setIsDialogOpen(false);
            return;
          }
        }

        setFilePath(selectedPath);
        setFileName(selectedFileName);

        // Auto-populate name if empty
        if (!form.getFieldValue('name')) {
          const nameWithoutExt = selectedFileName.replace(/\.[^/.]+$/, '');
          form.setFieldValue('name', nameWithoutExt);
        }

        message.success('File selected successfully');
      }
    } catch (error) {
      console.error('File dialog error:', error);
      message.error('Failed to open file browser');
    } finally {
      setIsDialogOpen(false);
    }
  };

  const isValidFileType = (filename) => {
    const validExtensions = {
      sqlite: ['.db', '.sqlite', '.sqlite3'],
      nedb: ['.db', '.nedb'],
      lancedb: ['.lance'],
      json: ['.json'],
      spreadsheet: ['.csv', '.xlsx', '.xls'],
      parquet: ['.parquet'],
      avro: ['.avro']
    };

    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
    const valid = validExtensions[fileType].includes(ext);

    if (!valid) {
      message.error(`Invalid file type. Expected: ${validExtensions[fileType].join(', ')}`);
    }

    return valid;
  };

  const handleBeforeUpload = async (file) => {
    // Validate file type (skip for LanceDB directories)
    if (fileType !== 'lancedb' && !isValidFileType(file.name)) {
      return Upload.LIST_IGNORE;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      // Use webUtils.getPathForFile() via preload script to extract real system path
      if (!window.electronAPI?.getFilePath) {
        console.error('getFilePath API not available');
        message.error('File path extraction not available. Please restart the application.');
        setUploading(false);
        return Upload.LIST_IGNORE;
      }

      const uploadedPath = window.electronAPI.getFilePath(file);
      console.log("Extracted file path:", uploadedPath);

      if (!uploadedPath) {
        console.error('File path not found. File object:', file);
        message.error('Could not read file path. Please try again.');
        setUploading(false);
        return Upload.LIST_IGNORE;
      }

      // Simulate progress for user feedback
      const progressInterval = setInterval(() => {
        setUploadProgress(prev => {
          if (prev >= 90) {
            clearInterval(progressInterval);
            return 90;
          }
          return prev + 10;
        });
      }, 100);

      setFilePath(uploadedPath);
      setFileName(file.name);

      // Auto-populate name if empty
      if (!form.getFieldValue('name')) {
        const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
        form.setFieldValue('name', nameWithoutExt);
      }

      clearInterval(progressInterval);
      setUploadProgress(100);

      setTimeout(() => {
        setUploading(false);
        setUploadProgress(0);
      }, 500);

      message.success('File selected successfully');
    } catch (error) {
      console.error('Upload error:', error);
      message.error('Failed to process file');
      setUploading(false);
      setUploadProgress(0);
    }

    return false; // Prevent default upload behavior
  };

  const handleSave = async () => {
    try {
      await form.validateFields();
      const values = form.getFieldsValue();

      if (!filePath) {
        message.error('Please select a file');
        return;
      }

      // Preserve the original file path before any imports
      const originalFilePath = filePath;

      // Check for duplicate connection names (only if not editing)
      if (!editingConnection && window.electronAPI?.db) {
        const existingConnections = await window.electronAPI.db.find('connections', {});
        const nameExists = existingConnections.some(
          conn => conn.name.toLowerCase() === values.name.toLowerCase()
        );

        if (nameExists) {
          message.error(`A connection named "${values.name}" already exists. Please choose a different name.`);
          return;
        }
      }

      let targetDbType;
      let targetFilePath = filePath;
      let connectionType = 'file';
      let importedTables = null;
      let schemas = null; // Store schema(s) from import

      setUploading(true);
      setUploadProgress(10);

      // For spreadsheet, parquet, avro, and JSON, we need to import to internal database first
      if (['spreadsheet', 'parquet', 'avro', 'json'].includes(fileType)) {
        setUploadProgress(30);

        if (fileType === 'spreadsheet' || fileType === 'parquet' || fileType === 'avro') {
          // Import CSV/Excel/Parquet/Avro to internal SQLite
          const importResult = await window.electronAPI.importToSqlite({
            filePath: filePath,
            tableName: values.name.replace(/[^a-zA-Z0-9_]/g, '_'),
            fileType: fileType // Pass file type to help backend determine how to parse
          });

          setUploadProgress(70);

          if (!importResult.success) {
            message.error('Failed to import file: ' + importResult.message);
            setUploading(false);
            setUploadProgress(0);
            return;
          }

          targetDbType = 'sqlite';
          targetFilePath = importResult.dbPath;
          importedTables = importResult.tables; // Store the imported table names
          schemas = importResult.schemas || importResult.schema; // Store schema(s)
          message.success(`Imported ${importResult.rowCount} rows to SQLite`);
        } else if (fileType === 'json') {
          // Import JSON to internal NeDB
          const importResult = await window.electronAPI.importToNeDB({
            filePath: filePath,
            collectionName: values.name.replace(/[^a-zA-Z0-9_]/g, '_')
          });

          setUploadProgress(70);

          if (!importResult.success) {
            message.error('Failed to import file: ' + importResult.message);
            setUploading(false);
            setUploadProgress(0);
            return;
          }

          targetDbType = 'nedb';
          targetFilePath = importResult.dbPath;
          message.success(`Imported ${importResult.docCount} documents to NeDB`);
        }

        setUploadProgress(90);
      } else {
        // SQLite, NeDB, and LanceDB - direct file reference
        targetDbType = fileType;
        setUploadProgress(50);

        // For LanceDB, list the tables in the database directory
        if (fileType === 'lancedb') {
          setUploadProgress(60);

          if (window.electronAPI?.listLanceDBTables) {
            try {
              const tablesResult = await window.electronAPI.listLanceDBTables(filePath);
              if (tablesResult.success) {
                importedTables = tablesResult.tables || [];
                message.success(`Found ${importedTables.length} table(s) in LanceDB`);
              } else {
                message.warning('Could not list LanceDB tables: ' + tablesResult.message);
              }
            } catch (error) {
              console.error('Failed to list LanceDB tables:', error);
              message.warning('Could not list LanceDB tables');
            }
          }

          setUploadProgress(80);
        }
      }

      const connectionData = {
        name: values.name,
        description: values.description,
        connectionType: connectionType,
        dbType: targetDbType,
        dbCategory: targetDbType === 'lancedb' ? 'Vector' : undefined,
        fileType: fileType,
        fileInfo: {
          originalName: fileName,
          filePath: targetFilePath,
          sourceFilePath: originalFilePath, // Keep original file path before any imports
          fileSize: null,
          uploadedAt: new Date().toISOString(),
          tables: importedTables, // Store which tables belong to this connection
          schemas: schemas, // Store schema(s) from import
        },
        status: 'ready',
        createdAt: editingConnection?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      setUploadProgress(100);
      setTimeout(() => {
        setUploading(false);
        setUploadProgress(0);
        onSave(connectionData);
      }, 500);
    } catch (error) {
      console.error('Save error:', error);
      message.error('Failed to save connection');
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const getTitle = () => {
    const titles = {
      sqlite: 'SQLite Database',
      nedb: 'NeDB Database',
      lancedb: 'LanceDB Vector Database',
      json: 'JSON File',
      spreadsheet: 'CSV/Excel File',
      parquet: 'Parquet File',
      avro: 'Avro File'
    };
    return titles[fileType] || 'Local File';
  };

  const getIcon = () => {
    const icons = {
      sqlite: <DatabaseOutlined style={{ fontSize: 48, color: '#0f80cc' }} />,
      nedb: <DatabaseOutlined style={{ fontSize: 48, color: '#52c41a' }} />,
      lancedb: <DatabaseOutlined style={{ fontSize: 48, color: '#722ed1' }} />,
      json: <FileTextOutlined style={{ fontSize: 48, color: '#fa8c16' }} />,
      spreadsheet: <FileTextOutlined style={{ fontSize: 48, color: '#1890ff' }} />,
      parquet: <DbIcon Icon={ParquetIcon} bg="#9254de" />,
      avro: <DbIcon Icon={AvroIcon} bg="#eb2f96" />
    };
    return icons[fileType] || <DatabaseOutlined style={{ fontSize: 48, color: '#1890ff' }} />;
  };

  const getDescription = () => {
    const descriptions = {
      sqlite: 'Connect to an existing SQLite database file on your computer',
      nedb: 'Connect to an existing NeDB database file on your computer',
      lancedb: 'Connect to a local LanceDB vector database directory',
      json: 'Upload a JSON file to import into a local NeDB database',
      spreadsheet: 'Upload a CSV or Excel file to import into a local SQLite database',
      parquet: 'Upload a Parquet file to import into a local SQLite database',
      avro: 'Upload an Avro file to import into a local SQLite database'
    };
    return descriptions[fileType] || 'Select a file to use as a data source';
  };

  const getDragText = () => {
    const texts = {
      sqlite: 'Click or drag SQLite database file to this area',
      nedb: 'Click or drag NeDB database file to this area',
      lancedb: 'Click to select LanceDB directory (contains .lance table folders)',
      json: 'Click or drag JSON file to this area to import',
      spreadsheet: 'Click or drag CSV or Excel file to this area to import',
      parquet: 'Click or drag Parquet file to this area to import',
      avro: 'Click or drag Avro file to this area to import'
    };
    return texts[fileType] || 'Click or drag file to this area';
  };

  const getAcceptedFiles = () => {
    const accepts = {
      sqlite: '.db,.sqlite,.sqlite3',
      nedb: '.db,.nedb',
      lancedb: '.lance',
      json: '.json',
      spreadsheet: '.csv,.xlsx,.xls',
      parquet: '.parquet',
      avro: '.avro'
    };
    return accepts[fileType] || '*';
  };

  const getHelpText = () => {
    const helps = {
      sqlite: 'SQLite database files (.db, .sqlite, .sqlite3)',
      nedb: 'NeDB database files (.db, .nedb)',
      lancedb: 'LanceDB vector database directory - Contains table folders with vector embeddings and metadata',
      json: 'JSON files (.json) - Arrays or single objects',
      spreadsheet: 'Excel (.xlsx, .xls) and CSV (.csv) files - Multi-sheet Excel files will create multiple tables',
      parquet: 'Parquet files (.parquet) - Columnar storage format',
      avro: 'Avro files (.avro) - Row-based storage format'
    };
    return helps[fileType] || 'Select a valid file';
  };

  const uploadProps = {
    name: 'file',
    multiple: false,
    accept: getAcceptedFiles(),
    beforeUpload: handleBeforeUpload,
    showUploadList: false,
    onDrop: () => setDragActive(false),
    onDragEnter: () => setDragActive(true),
    onDragLeave: () => setDragActive(false),
    // Disable default file dialog, we'll handle it ourselves
    openFileDialogOnClick: false,
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        {getIcon()}
        <Title level={4} style={{ marginTop: 8, marginBottom: 4 }}>
          {editingConnection ? `Edit ${getTitle()} Connection` : `Connect ${getTitle()}`}
        </Title>
        <Text type="secondary">
          {getDescription()}
        </Text>
      </div>

      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="Connection Name"
          rules={[
            { required: true, message: 'Please enter a connection name' },
            {
              validator: (_, value) => {
                if (!value) return Promise.resolve();

                // Check if name would be valid after sanitization
                const sanitized = value.replace(/[^a-zA-Z0-9_]/g, '_');
                if (sanitized === '' || /^[0-9_]+$/.test(sanitized)) {
                  return Promise.reject(new Error('Name must contain at least one letter'));
                }

                return Promise.resolve();
              }
            }
          ]}
          help="A unique name for this data source (letters, numbers, and underscores)"
        >
          <Input
            placeholder="e.g., Sales Data, Customer Records"
            disabled={uploading}
          />
        </Form.Item>

        <Form.Item
          name="description"
          label="Description"
          help="Optional description of this data source"
        >
          <TextArea
            rows={2}
            placeholder="Describe what this data source contains..."
            disabled={uploading}
          />
        </Form.Item>

        <Form.Item
          label={editingConnection ? "Replace File (Optional)" : "Select File"}
          required={!editingConnection}
        >
          {filePath && !uploading ? (
            <Card
              size="small"
              style={{
                backgroundColor: '#f6ffed',
                border: '1px solid #b7eb8f',
                marginBottom: 16
              }}
            >
              <Space>
                <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 20 }} />
                <div>
                  <Text strong>{fileName}</Text>
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Path: {filePath}
                  </Text>
                </div>
              </Space>
            </Card>
          ) : null}

          <div onClick={() => !uploading && !isDialogOpen && handleBrowseFile()} style={{ cursor: uploading ? 'default' : 'pointer' }}>
            <Dragger
              {...uploadProps}
              style={{
                padding: 20,
                backgroundColor: dragActive ? '#e6f7ff' : undefined
              }}
              disabled={uploading}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined style={{ fontSize: 48, color: uploading ? '#ccc' : '#1890ff' }} />
              </p>
              <p className="ant-upload-text">
                {uploading ? 'Processing...' : getDragText()}
              </p>
              <p className="ant-upload-hint">
                {getHelpText()}
                <br />
                <Text type="secondary" style={{ fontSize: '12px' }}>
                  {editingConnection && (
                    <>
                      <strong>Current file:</strong> {editingConnection.fileInfo?.originalName}
                    </>
                  )}
                </Text>
              </p>
            </Dragger>
          </div>
        </Form.Item>

        {uploading && (
          <div style={{ marginTop: 16, marginBottom: 16 }}>
            <Progress
              percent={uploadProgress}
              status="active"
              strokeColor={{
                '0%': '#108ee9',
                '100%': '#87d068',
              }}
            />
            <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 8 }}>
              {uploadProgress < 30 ? 'Reading file...' :
               uploadProgress < 70 ? 'Importing data...' :
               uploadProgress < 100 ? 'Finalizing...' :
               'Complete!'}
            </Text>
          </div>
        )}

        <div style={{ marginTop: 24, textAlign: 'right' }}>
          <Space>
            <Button onClick={onCancel} disabled={uploading}>
              Cancel
            </Button>
            <Button
              type="primary"
              onClick={handleSave}
              disabled={uploading || (!editingConnection && !filePath)}
              icon={uploading ? <LoadingOutlined /> : null}
              loading={uploading}
            >
              {editingConnection ? 'Update' : 'Create'} Connection
            </Button>
          </Space>
        </div>
      </Form>
    </Space>
  );
};

export default LocalFileConnectionForm;
