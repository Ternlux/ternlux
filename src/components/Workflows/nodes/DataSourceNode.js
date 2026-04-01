import React from 'react';
import { Handle, Position } from 'reactflow';
import { DatabaseOutlined } from '@ant-design/icons';
import { ReactComponent as PostgresIcon } from '../../ConnectorImages/Postgres.svg';
import { ReactComponent as MysqlIcon } from '../../ConnectorImages/Mysql.svg';
import { ReactComponent as MssqlIcon } from '../../ConnectorImages/Mssql.svg';
import { ReactComponent as MongodbIcon } from '../../ConnectorImages/Mongodb.svg';
import { ReactComponent as SqlliteIcon } from '../../ConnectorImages/Sqllite.svg';
import { ReactComponent as GoogleCloudStorageIcon } from '../../ConnectorImages/GoogleCloudStorage.svg';
import { ReactComponent as DropboxIcon } from '../../ConnectorImages/Dropbox.svg';
import { ReactComponent as GoogleDriveIcon } from '../../ConnectorImages/GoogleDrive.svg';
import { ReactComponent as GoogleSheetsIcon } from '../../ConnectorImages/GoogleSheets.svg';

// Helper to get database icon component
const getDbIcon = (dbType) => {
  const iconMap = {
    postgres: PostgresIcon,
    mysql: MysqlIcon,
    mssql: MssqlIcon,
    mongodb: MongodbIcon,
    sqlite: SqlliteIcon,
    gcs: GoogleCloudStorageIcon,
    dropbox: DropboxIcon,
    'google-drive': GoogleDriveIcon,
    'google-sheets': GoogleSheetsIcon,
  };
  return iconMap[dbType?.toLowerCase()] || null;
};

const DataSourceNode = ({ data, selected }) => {
  // console.log('DataSourceNode; ', data.config)
  // Check if the data source is configured
  // For CSV files, only connectionId is required (no table/dataset needed)
  const isConfigured = data.config?.sourceConnectionId &&
    (data.config?.sourceType === 'csv' || data.config?.table || data.config?.dataset || data.config?.sourceType);

  // Determine colors based on configuration status (keep border color logic)
  const borderColor = isConfigured ? '#52c41a' : '#d9d9d9';
  const iconColor = isConfigured ? '#52c41a' : '#999';
  const textColor = isConfigured ? '#333' : '#999';

  // Get database-specific icon
  const DbIconComponent = data.config?.dbType ? getDbIcon(data.config.dbType) : null;

  // Get display info
  const getDisplayName = () => {
    if (data.config?.sourceConnectionName) {
      return data.config.sourceConnectionName;
    }
    return isConfigured ? 'Configured Data Source' : 'Data Source';
  };

  const getSummary = () => {
    if (!isConfigured) return 'Click to configure data source';

    const config = data.config;
    if (config.sourceExplanation || config.sourceSqlExplanation) {
      const explanation = config.sourceExplanation || config.sourceSqlExplanation;
      return explanation.length > 100 ? explanation.slice(0, 100) + '...' : explanation;
    }

    if (config.sourceQueryDescription) {
      return config.sourceQueryDescription.length > 100
        ? config.sourceQueryDescription.slice(0, 100) + '...'
        : config.sourceQueryDescription;
    }

    if (config.sourceTable) {
      return `Loading data from ${config.sourceTable}`;
    }

    if (config.dataset) {
      return `Loading dataset: ${config.sourceDataset}`;
    }

    return 'Data source configured';
  };

  return (
    <div className={`react-flow__node-dataSource ${selected ? 'selected' : ''}`}
         style={{
           borderLeft: `4px solid ${borderColor}`,
           borderTop: `1px solid #e8e8e8`,
           borderRight: `1px solid #e8e8e8`,
           borderBottom: `2px solid #d0d0d0`,
           backgroundColor: '#fefce8',
           boxShadow: selected ? '0 4px 12px rgba(0,0,0,0.15)' : '0 2px 6px rgba(0,0,0,0.1)',
           borderRadius: '2px',
           minWidth: '220px',
           maxWidth: '280px',
           opacity: isConfigured ? 1 : 0.8,
         }}>
      {/* Target handle for incoming connections from start node */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: borderColor,
          border: '2px solid #fff',
          width: '10px',
          height: '10px',
          left: '-5px',
        }}
      />

      {/* Header with icon and name */}
      <div style={{
        padding: '10px 12px',
        borderBottom: '1px solid #f0f0f0',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        backgroundColor: 'rgba(255,255,255,0.5)',
      }}>
        {DbIconComponent ? (
          <DbIconComponent style={{ width: '18px', height: '18px', fill: iconColor }} />
        ) : (
          <DatabaseOutlined style={{ fontSize: '18px', color: iconColor }} />
        )}
        <div style={{
          fontWeight: '600',
          fontSize: '13px',
          color: textColor,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {getDisplayName()}
        </div>
      </div>

      {/* Summary description */}
      <div style={{
        padding: '12px',
        fontSize: '12px',
        lineHeight: '1.5',
        color: isConfigured ? '#555' : '#999',
        fontStyle: isConfigured ? 'normal' : 'italic',
        minHeight: '60px',
        maxHeight: '90px',
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 4,
        WebkitBoxOrient: 'vertical',
      }}>
        {getSummary()}
      </div>

      {/* Source handle for outgoing connections to other nodes */}
      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: borderColor,
          border: '2px solid #fff',
          width: '10px',
          height: '10px',
          right: '-5px',
        }}
      />
    </div>
  );
};

export default DataSourceNode;