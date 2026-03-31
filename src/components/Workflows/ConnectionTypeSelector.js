import React, { useState, useEffect } from 'react';
import { Modal, Card, Typography, Space, Button, Tag, message, Spin } from 'antd';
import { FileExcelOutlined, ArrowRightOutlined, DownloadOutlined, CheckCircleOutlined, FileTextOutlined, FileOutlined } from '@ant-design/icons';
import { ReactComponent as PostgresIcon } from '../ConnectorImages/Postgres.svg';
import { ReactComponent as MysqlIcon } from '../ConnectorImages/Mysql.svg';
import { ReactComponent as MssqlIcon } from '../ConnectorImages/Mssql.svg';
import { ReactComponent as MongodbIcon } from '../ConnectorImages/Mongodb.svg';
import { ReactComponent as SqlliteIcon } from '../ConnectorImages/Sqllite.svg';
import { ReactComponent as ParquetIcon } from '../ConnectorImages/Parquet.svg';
import { ReactComponent as AvroIcon } from '../ConnectorImages/Avro.svg';
import { ReactComponent as SnowflakeIcon } from '../ConnectorImages/Snowflake.svg';
import { ReactComponent as BigQueryIcon } from '../ConnectorImages/BigQuery.svg';
import { ReactComponent as GoogleCloudStorageIcon } from '../ConnectorImages/GoogleCloudStorage.svg';
import { ReactComponent as DropboxIcon } from '../ConnectorImages/Dropbox.svg';
import { ReactComponent as GoogleDriveIcon } from '../ConnectorImages/GoogleDrive.svg';
import { ReactComponent as GoogleSheetsIcon } from '../ConnectorImages/GoogleSheets.svg';

const { Title, Text } = Typography;

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

// Simple colored badge icons for generic databases
const GenericDbIcon = ({ letters, bg }) => (
  <div style={{
    width: 48, height: 48, borderRadius: 10,
    background: bg, display: 'flex', alignItems: 'center',
    justifyContent: 'center', color: '#fff',
    fontWeight: 800, fontSize: 13, letterSpacing: 0.5,
    userSelect: 'none',
  }}>
    {letters}
  </div>
);

const CONNECTION_TYPES = [
  {
    key: 'spreadsheet',
    title: 'Upload CSV/Excel',
    description: 'Import CSV or Excel files into local SQLite database',
    icon: <FileExcelOutlined style={{ fontSize: 48, color: '#1890ff' }} />,
    color: '#1890ff',
    category: 'file',
  },
  {
    key: 'json',
    title: 'Upload JSON',
    description: 'Import JSON files into local NeDB database',
    icon: <FileTextOutlined style={{ fontSize: 48, color: '#fa8c16' }} />,
    color: '#fa8c16',
    category: 'file',
  },
  {
    key: 'sqlite',
    title: 'SQLite File',
    description: 'Connect to an existing SQLite database file',
    icon: <DbIcon Icon={SqlliteIcon} bg="#0f80cc" />,
    color: '#0f80cc',
    category: 'file',
  },
  {
    key: 'nedb',
    title: 'NeDB File',
    description: 'Connect to an existing NeDB database file',
    icon: <FileOutlined style={{ fontSize: 48, color: '#52c41a' }} />,
    color: '#52c41a',
    category: 'file',
  },
  {
    key: 'parquet',
    title: 'Upload Parquet',
    description: 'Import Parquet files into local SQLite database',
    icon: <DbIcon Icon={ParquetIcon} bg="#9254de" />,
    color: '#9254de',
    category: 'file',
  },
  {
    key: 'avro',
    title: 'Upload Avro',
    description: 'Import Avro files into local SQLite database',
    icon: <DbIcon Icon={AvroIcon} bg="#eb2f96" />,
    color: '#eb2f96',
    category: 'file',
  },
  {
    key: 'postgres',
    title: 'PostgreSQL',
    description: 'Connect to a PostgreSQL database',
    icon: <DbIcon Icon={PostgresIcon} bg="#336791" />,
    color: '#336791',
    category: 'database',
  },
  {
    key: 'mysql',
    title: 'MySQL / MariaDB',
    description: 'Connect to a MySQL or MariaDB database',
    icon: <DbIcon Icon={MysqlIcon} bg="#e48b00" />,
    color: '#e48b00',
    category: 'database',
  },
  {
    key: 'mssql',
    title: 'SQL Server',
    description: 'Connect to a Microsoft SQL Server database',
    icon: <DbIcon Icon={MssqlIcon} bg="#0078d4" />,
    color: '#0078d4',
    category: 'database',
  },
  {
    key: 'mongodb',
    title: 'MongoDB',
    description: 'Connect to a MongoDB database or Atlas cluster',
    icon: <DbIcon Icon={MongodbIcon} bg="#00a550" />,
    color: '#00a550',
    category: 'database',
  },
  {
    key: 'redshift',
    title: 'Amazon Redshift',
    description: 'Connect to an Amazon Redshift data warehouse',
    icon: <GenericDbIcon letters="RS" bg="#ff9900" />,
    color: '#ff9900',
    category: 'database',
  },
  {
    key: 'bigquery',
    title: 'Google BigQuery',
    description: 'Connect to Google BigQuery data warehouse',
    icon: <DbIcon Icon={BigQueryIcon} bg="#4285f4" />,
    color: '#4285f4',
    category: 'database',
  },
  {
    key: 'snowflake',
    title: 'Snowflake',
    description: 'Connect to a Snowflake data warehouse',
    icon: <DbIcon Icon={SnowflakeIcon} bg="#29b5e8" />,
    color: '#29b5e8',
    category: 'database',
  },
  {
    key: 's3',
    title: 'Amazon S3',
    description: 'Connect to Amazon S3 object storage',
    icon: <GenericDbIcon letters="S3" bg="#ff9900" />,
    color: '#ff9900',
    category: 'storage',
  },
  {
    key: 'gcs',
    title: 'Google Cloud Storage',
    description: 'Connect to Google Cloud Storage',
    icon: <DbIcon Icon={GoogleCloudStorageIcon} bg="#4285f4" />,
    color: '#4285f4',
    category: 'storage',
  },
  {
    key: 'azure-blob',
    title: 'Azure Blob Storage',
    description: 'Connect to Azure Blob Storage',
    icon: <GenericDbIcon letters="AZ" bg="#0078d4" />,
    color: '#0078d4',
    category: 'storage',
  },
  {
    key: 'dropbox',
    title: 'Dropbox',
    description: 'Connect to Dropbox cloud storage',
    icon: <DbIcon Icon={DropboxIcon} bg="#0061ff" />,
    color: '#0061ff',
    category: 'storage',
  },
  {
    key: 'google-drive',
    title: 'Google Drive',
    description: 'Connect to Google Drive',
    icon: <DbIcon Icon={GoogleDriveIcon} bg="#34a853" />,
    color: '#34a853',
    category: 'storage',
  },
  {
    key: 'onedrive',
    title: 'OneDrive',
    description: 'Connect to Microsoft OneDrive',
    icon: <GenericDbIcon letters="OD" bg="#0078d4" />,
    color: '#0078d4',
    category: 'storage',
  },
  {
    key: 'sharepoint',
    title: 'SharePoint',
    description: 'Connect to SharePoint document libraries',
    icon: <GenericDbIcon letters="SP" bg="#0b828c" />,
    color: '#0b828c',
    category: 'storage',
  },
  {
    key: 'generic',
    title: 'Other Database',
    description: 'Oracle, DB2, and other databases',
    icon: <GenericDbIcon letters="DB" bg="#6c757d" />,
    color: '#6c757d',
    category: 'database',
  },
  {
    key: 'google-sheets',
    title: 'Google Sheets',
    description: 'Connect to Google Sheets via OAuth2.0',
    icon: <DbIcon Icon={GoogleSheetsIcon} bg="#34a853" />,
    color: '#34a853',
    category: 'api',
  },
];

const ConnectionTypeSelector = ({ open, onClose, onSelectType }) => {
  const [installedPlugins, setInstalledPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState({});

  useEffect(() => {
    if (open) {
      loadInstalledPlugins();
    }
  }, [open]);

  const loadInstalledPlugins = async () => {
    setLoading(true);
    try {
      if (window.electronAPI?.plugins?.listInstalled) {
        const result = await window.electronAPI.plugins.listInstalled();
        if (result.success) {
          setInstalledPlugins(result.connectors || []);
        }
      }
    } catch (error) {
      console.error('Failed to load installed plugins:', error);
    } finally {
      setLoading(false);
    }
  };

  const isPluginInstalled = (pluginKey) => {
    // File-based connections and generic don't require plugins
    const noPluginRequired = ['spreadsheet', 'json', 'sqlite', 'nedb', 'parquet', 'avro', 'generic'];
    if (noPluginRequired.includes(pluginKey)) {
      return true;
    }
    return installedPlugins.some(p => p.id === pluginKey);
  };

  const handleInstallPlugin = async (e, type) => {
    e.stopPropagation();
    setInstalling(prev => ({ ...prev, [type.key]: true }));

    try {
      if (!window.electronAPI?.plugins?.install) {
        message.error('Plugin installation not available');
        return;
      }

      const result = await window.electronAPI.plugins.install(type.key);

      if (result.success) {
        message.success(`${type.title} connector installed successfully!`);
        await loadInstalledPlugins();
      } else {
        message.error(`Failed to install: ${result.message}`);
      }
    } catch (error) {
      console.error('Installation error:', error);
      message.error('Failed to install plugin');
    } finally {
      setInstalling(prev => ({ ...prev, [type.key]: false }));
    }
  };

  const handleSelect = (type) => {
    if (!isPluginInstalled(type.key)) {
      message.warning(`Please install the ${type.title} connector first`);
      return;
    }
    onSelectType(type.key);
    onClose();
  };

  // Render a connection type card
  const renderCard = (type, buttonText, tagText) => {
    const installed = isPluginInstalled(type.key);
    const isInstalling = installing[type.key];

    return (
      <Card
        key={type.key}
        hoverable={installed}
        style={{
          textAlign: 'center',
          border: `2px solid ${installed ? '#f0f0f0' : '#ffccc7'}`,
          transition: 'all 0.2s ease',
          cursor: installed ? 'pointer' : 'default',
          opacity: installed ? 1 : 0.85,
          position: 'relative',
        }}
        bodyStyle={{ padding: '20px 16px' }}
        onClick={() => installed && handleSelect(type)}
        onMouseEnter={(e) => {
          if (installed) {
            e.currentTarget.style.borderColor = type.color;
            e.currentTarget.style.boxShadow = `0 4px 14px ${type.color}30`;
          }
        }}
        onMouseLeave={(e) => {
          if (installed) {
            e.currentTarget.style.borderColor = '#f0f0f0';
            e.currentTarget.style.boxShadow = 'none';
          }
        }}
      >
        {installed && (
          <Tag
            icon={<CheckCircleOutlined />}
            color="success"
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              fontSize: 11,
            }}
          >
            {tagText}
          </Tag>
        )}

        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'center' }}>{type.icon}</div>

          <div>
            <Title level={5} style={{ margin: '10px 0 4px', color: type.color, fontSize: 14 }}>
              {type.title}
            </Title>
            <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
              {type.description}
            </Text>
          </div>

          {installed ? (
            <Button
              type="primary"
              size="small"
              icon={<ArrowRightOutlined />}
              style={{ backgroundColor: type.color, borderColor: type.color, marginTop: 6 }}
              onClick={(e) => { e.stopPropagation(); handleSelect(type); }}
            >
              {buttonText}
            </Button>
          ) : (
            <Button
              type="default"
              size="small"
              icon={<DownloadOutlined />}
              loading={isInstalling}
              style={{ marginTop: 6 }}
              onClick={(e) => handleInstallPlugin(e, type)}
            >
              {isInstalling ? 'Installing...' : 'Install Plugin'}
            </Button>
          )}
        </Space>
      </Card>
    );
  };

  // Section configurations
  const sections = [
    {
      category: 'file',
      title: 'Local Files',
      gridColumns: 'repeat(4, 1fr)',
      buttonText: 'Select',
      tagText: 'Ready',
      marginBottom: 24,
    },
    {
      category: 'database',
      title: 'Database Connections',
      gridColumns: 'repeat(3, 1fr)',
      buttonText: 'Connect',
      tagText: 'Installed',
      marginTop: 0,
    },
    {
      category: 'storage',
      title: 'Cloud Storage',
      gridColumns: 'repeat(3, 1fr)',
      buttonText: 'Connect',
      tagText: 'Installed',
      marginTop: 24,
    },
    {
      category: 'api',
      title: 'API Connectors',
      gridColumns: 'repeat(3, 1fr)',
      buttonText: 'Connect',
      tagText: 'Installed',
      marginTop: 24,
    },
  ];

  return (
    <Modal
      title="Select Connection Type"
      open={open}
      onCancel={onClose}
      footer={null}
      width={860}
      destroyOnClose
    >
      <div style={{ padding: '20px 0' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <Title level={4}>Choose your data source</Title>
          <Text type="secondary">
            Upload local files, connect to databases, or cloud storage
          </Text>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin size="large" />
          </div>
        ) : (
          <>
            {sections.map((section, idx) => (
              <div
                key={section.category}
                style={{
                  marginTop: section.marginTop,
                  marginBottom: section.marginBottom,
                }}
              >
                <Title level={5} style={{ marginBottom: 16, color: '#8c8c8c' }}>
                  {section.title}
                </Title>
                <div style={{ display: 'grid', gridTemplateColumns: section.gridColumns, gap: 16 }}>
                  {CONNECTION_TYPES.filter(t => t.category === section.category).map((type) =>
                    renderCard(type, section.buttonText, section.tagText)
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
};

export default ConnectionTypeSelector;
