import React, { useState, useEffect } from 'react';
import {
  Modal,
  Breadcrumb,
  List,
  Button,
  Empty,
  Spin,
  message,
  Space,
  Typography,
  Tag,
  Card,
  Row,
  Col,
  Divider,
  Input,
  Select
} from 'antd';
import {
  FolderOutlined,
  FileOutlined,
  FileExcelOutlined,
  FileTextOutlined,
  DatabaseOutlined,
  ArrowLeftOutlined,
  HomeOutlined,
  SearchOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  FileImageOutlined,
  FilePdfOutlined
} from '@ant-design/icons';

const { Title, Text } = Typography;
const { Option } = Select;

/**
 * Cloud Storage Browser Component
 * Modern file browser for cloud storage providers (S3, GCS, Azure Blob, etc.)
 * Allows browsing folders, previewing files, and selecting data files
 *
 * @param {boolean} mode - 'import' (default) or 'output'
 *   - import: Select existing files to import locally
 *   - output: Select path and enter filename for uploading
 * @param {string} sourceDbType - Source database type (for determining default output format)
 */
const CloudStorageBrowser = ({
  open,
  onClose,
  connection,
  onFileSelect,
  pluginManager,
  mode = 'import', // 'import' or 'output'
  sourceDbType = null // Source database type for output mode
}) => {
  const [loading, setLoading] = useState(false);
  const [containers, setContainers] = useState([]);
  const [currentContainer, setCurrentContainer] = useState(null);
  const [objects, setObjects] = useState([]);
  const [currentPath, setCurrentPath] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [downloadingFile, setDownloadingFile] = useState(false);
  const [filePreview, setFilePreview] = useState(null);
  const [availableSheets, setAvailableSheets] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState(null);
  const [processingFile, setProcessingFile] = useState(false);
  const [outputFileName, setOutputFileName] = useState('');
  const [continuationToken, setContinuationToken] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageSize] = useState(100); // Number of items per page

  // Determine default output format based on source database type
  const getDefaultFormat = () => {
    if (!sourceDbType) return 'csv';
    const noSqlTypes = ['mongodb', 'nedb'];
    return noSqlTypes.includes(sourceDbType.toLowerCase()) ? 'json' : 'csv';
  };

  const [outputFormat, setOutputFormat] = useState(getDefaultFormat());

  useEffect(() => {
    if (open && connection) {
      loadContainers();
      // Reset output format based on source type when opening
      if (mode === 'output') {
        setOutputFormat(getDefaultFormat());
      }
    }
  }, [open, connection, sourceDbType]);

  // Debounced search effect
  useEffect(() => {
    if (!currentContainer) return;

    const debounceTimer = setTimeout(() => {
      const folderPath = currentPath.map(p => p.name).join('/');
      const prefix = folderPath ? folderPath + '/' : '';
      loadObjects(currentContainer.name || currentContainer.id, prefix, true);
    }, 500); // 500ms debounce

    return () => clearTimeout(debounceTimer);
  }, [searchTerm]);

  const loadContainers = async () => {
    setLoading(true);
    try {
      if (!window.electronAPI?.cloudStorage?.getContainers) {
        message.error('Cloud storage API not available');
        return;
      }

      const result = await window.electronAPI.cloudStorage.getContainers(
        connection.id,
        connection.dbType
      );

      if (result.success) {
        setContainers(result.containers || []);
      } else {
        message.error('Failed to load containers: ' + result.message);
      }
    } catch (error) {
      console.error('Error loading containers:', error);
      message.error('Failed to load containers');
    } finally {
      setLoading(false);
    }
  };

  const loadObjects = async (containerName, prefix = '', resetPagination = true, searchTermOverride = null) => {
    setLoading(true);
    try {
      if (!window.electronAPI?.cloudStorage?.listObjects) {
        message.error('Cloud storage API not available');
        return;
      }

      const effectiveSearchTerm = searchTermOverride !== null ? searchTermOverride : searchTerm;

      const result = await window.electronAPI.cloudStorage.listObjects(
        connection.id,
        connection.dbType,
        containerName,
        prefix,
        pageSize,
        resetPagination ? null : continuationToken,
        effectiveSearchTerm
      );
      console.log('loadObjects: ', result)
      if (result.success) {
        if (resetPagination) {
          setObjects(result.objects || []);
        } else {
          // Append to existing objects for "Load More"
          setObjects(prev => [...prev, ...(result.objects || [])]);
        }
        setContinuationToken(result.nextContinuationToken || null);
        setHasMore(result.isTruncated || false);
      } else {
        message.error('Failed to load files: ' + result.message);
      }
    } catch (error) {
      console.error('Error loading objects:', error);
      message.error('Failed to load files');
    } finally {
      setLoading(false);
    }
  };

  const loadMoreObjects = async () => {
    if (!hasMore || loadingMore) return;

    setLoadingMore(true);
    try {
      if (!window.electronAPI?.cloudStorage?.listObjects) {
        message.error('Cloud storage API not available');
        return;
      }

      const folderPath = currentPath.map(p => p.name).join('/');
      const prefix = folderPath ? folderPath + '/' : '';

      const result = await window.electronAPI.cloudStorage.listObjects(
        connection.id,
        connection.dbType,
        currentContainer.name || currentContainer.id,
        prefix,
        pageSize,
        continuationToken,
        searchTerm
      );

      if (result.success) {
        setObjects(prev => [...prev, ...(result.objects || [])]);
        setContinuationToken(result.nextContinuationToken || null);
        setHasMore(result.isTruncated || false);
      } else {
        message.error('Failed to load more files: ' + result.message);
      }
    } catch (error) {
      console.error('Error loading more objects:', error);
      message.error('Failed to load more files');
    } finally {
      setLoadingMore(false);
    }
  };

  const handleContainerClick = (container) => {
    setCurrentContainer(container);
    setCurrentPath([]);
    setSearchTerm(''); // Reset search when switching containers
    loadObjects(container.name || container.id, '', true, '');
  };

  const handleObjectClick = (object) => {
    if (object.isFolder) {
      // Navigate into folder
      setCurrentPath([...currentPath, object]);
      const folderPath = [...currentPath, object].map(p => p.name).join('/');
      loadObjects(currentContainer.name || currentContainer.id, folderPath + '/', true);
    } else if (mode === 'import') {
      // Check if file type is supported before selecting
      if (checkFileType(object)) {
        setSelectedFile(object);
      }
    }
    // In output mode, clicking files does nothing - user navigates to folders and enters filename
  };

  const handleBreadcrumbClick = (index) => {
    if (index === -1) {
      // Back to containers
      setCurrentContainer(null);
      setCurrentPath([]);
      setObjects([]);
      setSelectedFile(null);
      setFilePreview(null);
      setSearchTerm('');
      setContinuationToken(null);
      setHasMore(false);
    } else if (index === 0 && currentPath.length > 0) {
      // Back to container root
      setCurrentPath([]);
      setSelectedFile(null);
      setFilePreview(null);
      loadObjects(currentContainer.name || currentContainer.id, '', true);
    } else if (index < currentPath.length) {
      // Navigate to specific folder
      const newPath = currentPath.slice(0, index);
      setCurrentPath(newPath);
      const folderPath = newPath.map(p => p.name).join('/');
      setSelectedFile(null);
      setFilePreview(null);
      loadObjects(currentContainer.name || currentContainer.id, folderPath ? folderPath + '/' : '', true);
    }
  };

  const isSupportedFileType = (fileName) => {
    const name = fileName.toLowerCase();
    const supportedTypes = ['.csv', '.xlsx', '.xls', '.json', '.sqlite', '.db', '.parquet', '.avro', '.nedb'];
    return supportedTypes.some(ext => name.endsWith(ext));
  };

  const checkFileType = (file) => {
    const isSupported = isSupportedFileType(file.name);

    if (!isSupported) {
      message.warning('This file type is not supported. Please select CSV, Excel, JSON, SQLite, Parquet, Avro, or NeDB files.');
      setSelectedFile(null); // Don't allow selection of unsupported files
      return false;
    }
    return true;
  };

  const getFileIcon = (fileName) => {
    const name = fileName.toLowerCase();
    if (name.endsWith('.csv')) return <FileTextOutlined style={{ fontSize: 24, color: '#52c41a' }} />;
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) return <FileExcelOutlined style={{ fontSize: 24, color: '#1890ff' }} />;
    if (name.endsWith('.json')) return <FileTextOutlined style={{ fontSize: 24, color: '#fa8c16' }} />;
    if (name.endsWith('.sqlite') || name.endsWith('.db') || name.endsWith('.nedb')) return <DatabaseOutlined style={{ fontSize: 24, color: '#722ed1' }} />;
    if (name.endsWith('.parquet')) return <DatabaseOutlined style={{ fontSize: 24, color: '#eb2f96' }} />;
    if (name.endsWith('.avro')) return <DatabaseOutlined style={{ fontSize: 24, color: '#13c2c2' }} />;
    if (name.endsWith('.pdf')) return <FilePdfOutlined style={{ fontSize: 24, color: '#f5222d' }} />;
    if (name.match(/\.(jpg|jpeg|png|gif|bmp|svg)$/)) return <FileImageOutlined style={{ fontSize: 24, color: '#faad14' }} />;
    return <FileOutlined style={{ fontSize: 24, color: '#8c8c8c' }} />;
  };

  const getFileTypeTag = (fileName) => {
    const name = fileName.toLowerCase();
    if (name.endsWith('.csv')) return <Tag color="success">CSV</Tag>;
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) return <Tag color="blue">Excel</Tag>;
    if (name.endsWith('.json')) return <Tag color="orange">JSON</Tag>;
    if (name.endsWith('.sqlite') || name.endsWith('.db')) return <Tag color="purple">SQLite</Tag>;
    if (name.endsWith('.nedb')) return <Tag color="purple">NeDB</Tag>;
    if (name.endsWith('.parquet')) return <Tag color="magenta">Parquet</Tag>;
    if (name.endsWith('.avro')) return <Tag color="cyan">Avro</Tag>;
    return <Tag color="default">File</Tag>;
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const handleDownloadAndImport = async () => {
    if (!selectedFile) return;

    setDownloadingFile(true);
    setProcessingFile(true);

    try {
      if (!window.electronAPI?.cloudStorage?.downloadObject) {
        message.error('Cloud storage API not available');
        setProcessingFile(false);
        return;
      }

      // Use objectKey if available, otherwise construct path-based key
      const objectIdentifier = selectedFile.objectKey || selectedFile.name;

      // Download file from cloud storage
      const downloadResult = await window.electronAPI.cloudStorage.downloadObject(
        connection.id,
        connection.dbType,
        currentContainer.name || currentContainer.id,
        objectIdentifier
      );

      if (!downloadResult.success) {
        message.error('Failed to download file: ' + downloadResult.message);
        return;
      }

      // Determine file type and import to local storage
      const fileName = selectedFile.name;
      const fileType = getLocalFileType(fileName);

      if (!fileType) {
        message.error('Unsupported file type');
        return;
      }

      // Check if it's Excel with multiple sheets
      if (fileName.toLowerCase().endsWith('.xlsx') || fileName.toLowerCase().endsWith('.xls')) {
        // Need to check sheets first
        const sheets = await analyzeExcelFile(downloadResult.data);
        if (sheets.length > 1) {
          setAvailableSheets(sheets);
          setFilePreview({ type: 'excel-multisheet', data: downloadResult.data });
          setProcessingFile(false);
          message.info('This Excel file has multiple sheets. Please select one.');
          return;
        } else if (sheets.length === 1) {
          // Single sheet - proceed with import
          await importFileToLocal(downloadResult.data, fileName, fileType, sheets[0]);
        }
      } else {
        // Not Excel - import directly
        await importFileToLocal(downloadResult.data, fileName, fileType, null);
      }
    } catch (error) {
      console.error('Error downloading file:', error);
      message.error('Failed to download and import file');
      setProcessingFile(false);
    } finally {
      setDownloadingFile(false);
    }
  };

  const analyzeExcelFile = async (fileData) => {
    // This would use XLSX library to read sheet names
    if (!window.electronAPI?.fileReaderEnhanced?.analyzeExcel) {
      return ['Sheet1']; // Fallback
    }

    try {
      const result = await window.electronAPI.fileReaderEnhanced.analyzeExcel(fileData);
      return result.sheets || ['Sheet1'];
    } catch (error) {
      console.error('Error analyzing Excel:', error);
      return ['Sheet1'];
    }
  };

  const importFileToLocal = async (fileData, fileName, fileType, sheetName) => {
    try {
      // Call electron API to import file to local SQLite/NeDB
      if (!window.electronAPI?.cloudStorage?.importFile) {
        message.error('Cloud storage import not available');
        return;
      }

      const result = await window.electronAPI.cloudStorage.importFile({
        data: fileData,
        fileName: fileName,
        fileType: fileType,
        sheetName: sheetName,
        containerName: currentContainer.name || currentContainer.id,
        connectionName: connection.name
      });

      if (result.success) {
        message.success('File imported successfully!');

        // Include sheet name in file name if provided
        const displayFileName = sheetName
          ? `${fileName} (${sheetName})`
          : fileName;

        // Return the imported file info to parent component
        onFileSelect({
          fileName: displayFileName,
          localPath: result.localPath,
          dbType: result.dbType, // 'sqlite' or 'nedb'
          tables: result.tables,
          sheetName: sheetName, // Pass sheet name for reference
          schemas: result.schemas || result.schema, // Pass schema(s) from import
          cloudSource: {
            connectionId: connection.id,
            connectionName: connection.name,
            containerName: currentContainer.name || currentContainer.id,
            objectName: selectedFile.name,
            objectPath: [...currentPath, selectedFile].map(p => p.name).join('/')
          }
        });

        onClose();
      } else {
        message.error('Failed to import file: ' + result.message);
      }
    } catch (error) {
      console.error('Error importing file:', error);
      message.error('Failed to import file');
    } finally {
      setProcessingFile(false);
    }
  };

  const handleSheetSelection = async (sheetName) => {
    setSelectedSheet(sheetName);
    if (filePreview && filePreview.type === 'excel-multisheet') {
      setProcessingFile(true);
      await importFileToLocal(filePreview.data, selectedFile.name, 'spreadsheet', sheetName);
    }
  };

  const getLocalFileType = (fileName) => {
    const name = fileName.toLowerCase();
    if (name.endsWith('.csv') || name.endsWith('.xlsx') || name.endsWith('.xls')) return 'spreadsheet';
    if (name.endsWith('.json')) return 'json';
    if (name.endsWith('.sqlite') || name.endsWith('.db')) return 'sqlite';
    if (name.endsWith('.nedb')) return 'nedb';
    if (name.endsWith('.parquet')) return 'parquet';
    if (name.endsWith('.avro')) return 'avro';
    return null;
  };

  const handleSelectOutputPath = () => {
    if (!currentContainer) {
      message.error('Please select a container first');
      return;
    }

    if (!outputFileName.trim()) {
      message.error('Please enter a filename');
      return;
    }

    // Automatically append the extension based on selected format
    const extension = `.${outputFormat}`;
    const fileNameWithExtension = outputFileName.endsWith(extension)
      ? outputFileName
      : `${outputFileName}${extension}`;
    console.log('currentContainer: ', currentContainer)
    // Build the full path
    const folderPath = currentPath.map(p => p.name).join('/');
    const objectPath = folderPath ? `${folderPath}/${fileNameWithExtension}` : fileNameWithExtension;
    // Use ID for cloud storage APIs (e.g., Google Drive "root"), fallback to name
    const containerName = currentContainer.id || currentContainer.name;

    onFileSelect({
      containerName,
      objectPath,
      fullPath: `${containerName}/${objectPath}`
    });

    onClose();
  };

  // No need for frontend filtering anymore - search is done server-side
  const filteredObjects = objects;

  return (
    <Modal
      title={
        <Space>
          <CloudDownloadOutlined style={{ fontSize: 20, color: '#1890ff' }} />
          <Text strong>Cloud Storage Browser</Text>
          {connection && <Tag color="blue">{connection.name}</Tag>}
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={900}
      footer={null}
      destroyOnClose
      styles={{ body: { padding: 0, maxHeight: '70vh', overflow: 'hidden' } }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '70vh' }}>
        {/* Breadcrumb Navigation */}
        <div style={{ padding: '16px 24px', borderBottom: '1px solid #f0f0f0', background: '#fafafa' }}>
          <Breadcrumb>
            <Breadcrumb.Item>
              <Button
                type="text"
                size="small"
                icon={<HomeOutlined />}
                onClick={() => handleBreadcrumbClick(-1)}
                disabled={!currentContainer}
              >
                Containers
              </Button>
            </Breadcrumb.Item>
            {currentContainer && (
              <Breadcrumb.Item>
                <Button
                  type="text"
                  size="small"
                  onClick={() => handleBreadcrumbClick(0)}
                  disabled={currentPath.length === 0}
                  style={{ fontWeight: currentPath.length === 0 ? 600 : 400 }}
                >
                  {currentContainer.name || currentContainer.id}
                </Button>
              </Breadcrumb.Item>
            )}
            {currentPath.map((folder, index) => (
              <Breadcrumb.Item key={index}>
                <Button
                  type="text"
                  size="small"
                  onClick={() => handleBreadcrumbClick(index + 1)}
                  disabled={index === currentPath.length - 1}
                  style={{ fontWeight: index === currentPath.length - 1 ? 600 : 400 }}
                >
                  {folder.name}
                </Button>
              </Breadcrumb.Item>
            ))}
          </Breadcrumb>

          {currentContainer && (
            <Input
              placeholder="Search files (server-side)..."
              prefix={<SearchOutlined />}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ marginTop: 12 }}
              allowClear
              suffix={loading && <Spin size="small" />}
            />
          )}
        </div>

        {/* Main Content Area */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* File List */}
          <div style={{
            flex: selectedFile ? '0 0 55%' : 1,
            padding: 24,
            overflowY: 'auto',
            borderRight: selectedFile ? '1px solid #f0f0f0' : 'none'
          }}>
            {loading ? (
              <div style={{ textAlign: 'center', padding: 60 }}>
                <Spin size="large" />
                <div style={{ marginTop: 16, color: '#8c8c8c' }}>Loading...</div>
              </div>
            ) : !currentContainer ? (
              // Show Containers
              <div>
                <Title level={5} style={{ marginBottom: 16 }}>Select a Container</Title>
                {containers.length === 0 ? (
                  connection.dbType === 'azure-blob' ? (
                    <Card style={{ maxWidth: 600, margin: '0 auto' }}>
                      <Empty
                        description={
                          <div>
                            <Text strong style={{ fontSize: 16 }}>No Containers Found</Text>
                            <div style={{ marginTop: 16, textAlign: 'left' }}>
                              <Text>To use Azure Blob Storage, you need to create a container first:</Text>
                              <ol style={{ marginTop: 12, paddingLeft: 20 }}>
                                <li style={{ marginBottom: 8 }}>
                                  Go to <a href="https://portal.azure.com" target="_blank" rel="noopener noreferrer">Azure Portal</a>
                                </li>
                                <li style={{ marginBottom: 8 }}>
                                  Navigate to your Storage Account
                                </li>
                                <li style={{ marginBottom: 8 }}>
                                  Click <strong>"Containers"</strong> in the left menu
                                </li>
                                <li style={{ marginBottom: 8 }}>
                                  Click <strong>"+ Container"</strong> at the top
                                </li>
                                <li style={{ marginBottom: 8 }}>
                                  Enter a name (e.g., <code>my-data</code>, <code>exports</code>)
                                </li>
                                <li style={{ marginBottom: 8 }}>
                                  Set access level to <strong>"Private"</strong>
                                </li>
                                <li>
                                  Click <strong>"Create"</strong>
                                </li>
                              </ol>
                              <div style={{ marginTop: 16, padding: 12, background: '#f0f5ff', borderRadius: 4 }}>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  <strong>Note:</strong> Container names must be lowercase, 3-63 characters, and can only contain letters, numbers, and hyphens.
                                </Text>
                              </div>
                              <div style={{ marginTop: 16, textAlign: 'center' }}>
                                <Button type="primary" onClick={loadContainers}>
                                  Refresh Containers
                                </Button>
                              </div>
                            </div>
                          </div>
                        }
                      />
                    </Card>
                  ) : (
                    <Empty description="No containers found" />
                  )
                ) : (
                  <List
                    grid={{ gutter: 16, xs: 1, sm: 2, md: 2, lg: 2, xl: 2 }}
                    dataSource={containers}
                    renderItem={container => (
                      <List.Item>
                        <Card
                          hoverable
                          onClick={() => handleContainerClick(container)}
                          style={{ textAlign: 'center' }}
                          bodyStyle={{ padding: 24 }}
                        >
                          <FolderOutlined style={{ fontSize: 48, color: '#faad14', marginBottom: 12 }} />
                          <Title level={5} style={{ margin: 0 }}>{container.name || container.id}</Title>
                          {container.description && (
                            <Text type="secondary" style={{ fontSize: 12 }}>{container.description}</Text>
                          )}
                        </Card>
                      </List.Item>
                    )}
                  />
                )}
              </div>
            ) : (
              // Show Objects (files and folders)
              <div>
                <Title level={5} style={{ marginBottom: 16 }}>
                  {filteredObjects.length} {filteredObjects.length === 1 ? 'item' : 'items'}
                  {hasMore && <Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal', marginLeft: 8 }}>(more available)</Text>}
                  {searchTerm && <Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal', marginLeft: 8 }}>- filtered by "{searchTerm}"</Text>}
                </Title>
                {filteredObjects.length === 0 ? (
                  <Empty description="No files found" />
                ) : (
                  <List
                    dataSource={filteredObjects}
                    renderItem={object => {
                      const isFile = !object.isFolder;
                      const isSupported = isFile ? isSupportedFileType(object.name) : true;
                      const isClickable = object.isFolder || (mode === 'import' && isSupported);

                      return (
                        <List.Item
                          onClick={() => isClickable ? handleObjectClick(object) : null}
                          style={{
                            cursor: isClickable ? 'pointer' : 'not-allowed',
                            padding: '12px 16px',
                            borderRadius: 8,
                            border: selectedFile?.name === object.name ? '2px solid #1890ff' : '1px solid #f0f0f0',
                            marginBottom: 8,
                            background: selectedFile?.name === object.name ? '#e6f7ff' : '#fff',
                            transition: 'all 0.2s',
                            opacity: (isFile && !isSupported) || (!object.isFolder && mode === 'output') ? 0.5 : 1
                          }}
                          onMouseEnter={(e) => {
                            if (isClickable && selectedFile?.name !== object.name) {
                              e.currentTarget.style.background = '#fafafa';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (isClickable && selectedFile?.name !== object.name) {
                              e.currentTarget.style.background = '#fff';
                            }
                          }}
                        >
                        <List.Item.Meta
                          avatar={
                            object.isFolder
                              ? <FolderOutlined style={{ fontSize: 24, color: '#faad14' }} />
                              : getFileIcon(object.name)
                          }
                          title={
                            <Space>
                              <Text strong style={{ fontSize: 14, opacity: (isFile && !isSupported) ? 0.6 : 1 }}>
                                {object.name}
                              </Text>
                              {!object.isFolder && getFileTypeTag(object.name)}
                              {isFile && !isSupported && mode === 'import' && (
                                <Tag color="default">Unsupported</Tag>
                              )}
                              {selectedFile?.name === object.name && (
                                <CheckCircleOutlined style={{ color: '#1890ff' }} />
                              )}
                            </Space>
                          }
                          description={
                            !object.isFolder && (
                              <Space size="large">
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {formatFileSize(object.size)}
                                </Text>
                                {object.lastModified && (
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    {new Date(object.lastModified).toLocaleDateString()}
                                  </Text>
                                )}
                              </Space>
                            )
                          }
                        />
                      </List.Item>
                    );
                    }}
                  />
                )}

                {/* Load More Button */}
                {hasMore && !loading && filteredObjects.length > 0 && (
                  <div style={{ textAlign: 'center', marginTop: 16 }}>
                    <Button
                      onClick={loadMoreObjects}
                      loading={loadingMore}
                      size="large"
                      style={{ minWidth: 200 }}
                    >
                      {loadingMore ? 'Loading...' : `Load More (${filteredObjects.length} loaded)`}
                    </Button>
                    <div style={{ marginTop: 8 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        Showing {filteredObjects.length} items. Click to load more.
                      </Text>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* File Details Panel (Import Mode) */}
          {mode === 'import' && selectedFile && (
            <div style={{
              flex: '0 0 45%',
              padding: 24,
              overflowY: 'auto',
              background: '#fafafa'
            }}>
              <Title level={5} style={{ marginBottom: 16 }}>File Details</Title>

              <Card style={{ marginBottom: 16 }}>
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  <div style={{ textAlign: 'center', padding: '24px 0' }}>
                    {getFileIcon(selectedFile.name)}
                    <Title level={5} style={{ margin: '12px 0 4px' }}>{selectedFile.name}</Title>
                    {getFileTypeTag(selectedFile.name)}
                  </div>

                  <Divider style={{ margin: '12px 0' }} />

                  <Row gutter={[16, 12]}>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 12 }}>Size</Text>
                    </Col>
                    <Col span={16}>
                      <Text strong>{formatFileSize(selectedFile.size)}</Text>
                    </Col>

                    {selectedFile.lastModified && (
                      <>
                        <Col span={8}>
                          <Text type="secondary" style={{ fontSize: 12 }}>Modified</Text>
                        </Col>
                        <Col span={16}>
                          <Text>{new Date(selectedFile.lastModified).toLocaleString()}</Text>
                        </Col>
                      </>
                    )}

                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 12 }}>Location</Text>
                    </Col>
                    <Col span={16}>
                      <Text style={{ fontSize: 12, wordBreak: 'break-all' }}>
                        {[currentContainer.name, ...currentPath.map(p => p.name)].join(' / ')}
                      </Text>
                    </Col>
                  </Row>
                </Space>
              </Card>

              {/* Sheet Selection for Excel */}
              {availableSheets.length > 1 && (
                <Card style={{ marginBottom: 16 }}>
                  <Title level={5} style={{ fontSize: 14, marginBottom: 12 }}>Select Sheet</Title>
                  <Select
                    placeholder="Choose a sheet"
                    style={{ width: '100%' }}
                    value={selectedSheet}
                    onChange={handleSheetSelection}
                    disabled={processingFile}
                  >
                    {availableSheets.map(sheet => (
                      <Option key={sheet} value={sheet}>{sheet}</Option>
                    ))}
                  </Select>
                </Card>
              )}

              {/* Import Button */}
              <Button
                type="primary"
                size="large"
                block
                icon={<CloudDownloadOutlined />}
                onClick={handleDownloadAndImport}
                loading={downloadingFile || processingFile}
                disabled={
                  (availableSheets.length > 1 && !selectedSheet) ||
                  !isSupportedFileType(selectedFile.name)
                }
              >
                {processingFile ? 'Importing...' : downloadingFile ? 'Downloading...' : 'Import File'}
              </Button>

              {!isSupportedFileType(selectedFile.name) ? (
                <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 12, fontSize: 12, color: '#ff4d4f' }}>
                  This file type is not supported for import
                </Text>
              ) : (
                <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 12, fontSize: 12 }}>
                  File will be imported to local storage
                </Text>
              )}
            </div>
          )}

          {/* Output Path Selection Panel (Output Mode) */}
          {mode === 'output' && currentContainer && (
            <div style={{
              flex: '0 0 45%',
              padding: 24,
              overflowY: 'auto',
              background: '#fafafa'
            }}>
              <Title level={5} style={{ marginBottom: 16 }}>Output Destination</Title>

              <Card style={{ marginBottom: 16 }}>
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  <div>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Container</Text>
                    <Text strong style={{ fontSize: 16 }}>{currentContainer.name || currentContainer.id}</Text>
                  </div>

                  <Divider style={{ margin: '8px 0' }} />

                  <div>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Folder Path</Text>
                    <Text style={{ fontSize: 14 }}>
                      {currentPath.length > 0 ? currentPath.map(p => p.name).join(' / ') : '/ (root)'}
                    </Text>
                  </div>

                  <Divider style={{ margin: '8px 0' }} />

                  <div>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>Output Format *</Text>
                    <Select
                      value={outputFormat}
                      onChange={(value) => setOutputFormat(value)}
                      style={{ width: '100%' }}
                      size="large"
                    >
                      <Option value="json">
                        <Space>
                          <Tag color="orange">JSON</Tag>
                          <Text>JSON Format {sourceDbType && ['mongodb', 'nedb'].includes(sourceDbType.toLowerCase()) && '(Recommended for NoSQL)'}</Text>
                        </Space>
                      </Option>
                      <Option value="csv">
                        <Space>
                          <Tag color="success">CSV</Tag>
                          <Text>CSV Format {sourceDbType && !['mongodb', 'nedb'].includes(sourceDbType.toLowerCase()) && '(Recommended for SQL)'}</Text>
                        </Space>
                      </Option>
                    </Select>
                  </div>

                  <Divider style={{ margin: '8px 0' }} />

                  <div>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>Output Filename *</Text>
                    <Input
                      placeholder="output (extension will be added automatically)"
                      value={outputFileName}
                      onChange={(e) => setOutputFileName(e.target.value)}
                      onPressEnter={handleSelectOutputPath}
                      size="large"
                      suffix={
                        outputFormat === 'json' ? <Tag color="orange">.json</Tag> : <Tag color="success">.csv</Tag>
                      }
                    />
                    <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                      Extension (.{outputFormat}) will be added automatically
                    </Text>
                  </div>

                  <Divider style={{ margin: '8px 0' }} />

                  <div>
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Full Path Preview</Text>
                    <Text code style={{ fontSize: 12, display: 'block', wordBreak: 'break-all', padding: '8px', background: '#f5f5f5', borderRadius: 4 }}>
                      {(() => {
                        const extension = `.${outputFormat}`;
                        const fileNameWithExt = outputFileName ? (outputFileName.endsWith(extension) ? outputFileName : `${outputFileName}${extension}`) : `filename${extension}`;
                        return currentPath.length > 0
                          ? `${currentContainer.name || currentContainer.id}/${currentPath.map(p => p.name).join('/')}/${fileNameWithExt}`
                          : `${currentContainer.name || currentContainer.id}/${fileNameWithExt}`;
                      })()}
                    </Text>
                  </div>
                </Space>
              </Card>

              {/* Select Path Button */}
              <Button
                type="primary"
                size="large"
                block
                onClick={handleSelectOutputPath}
                disabled={!outputFileName.trim()}
              >
                Select This Path
              </Button>

              <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 12, fontSize: 12 }}>
                Navigate to folders above and enter a filename
              </Text>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default CloudStorageBrowser;
