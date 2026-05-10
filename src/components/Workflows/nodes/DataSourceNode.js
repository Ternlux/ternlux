import React from 'react';
import { Handle, Position } from 'reactflow';
import { DatabaseOutlined } from '@ant-design/icons';
import { ExpandableCodes, extractLatestCodes, getLatestUserQuestion } from './nodeCardShared';
import { ReactComponent as PostgresIcon } from '../../ConnectorImages/Postgres.svg';
import { ReactComponent as MysqlIcon } from '../../ConnectorImages/Mysql.svg';
import { ReactComponent as MssqlIcon } from '../../ConnectorImages/Mssql.svg';
import { ReactComponent as MongodbIcon } from '../../ConnectorImages/Mongodb.svg';
import { ReactComponent as SqlliteIcon } from '../../ConnectorImages/Sqllite.svg';
import { ReactComponent as GoogleCloudStorageIcon } from '../../ConnectorImages/GoogleCloudStorage.svg';
import { ReactComponent as DropboxIcon } from '../../ConnectorImages/Dropbox.svg';
import { ReactComponent as GoogleDriveIcon } from '../../ConnectorImages/GoogleDrive.svg';
import { ReactComponent as GoogleSheetsIcon } from '../../ConnectorImages/GoogleSheets.svg';

const COLOR = '#0891b2';
const MONO = "'JetBrains Mono', monospace";
const TEXT = '#111827';
const MUTED = '#5a6678';
const BORDER = '#e2e6eb';
const GREEN = '#059669';

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
  const isConfigured = data.config?.sourceConnectionId &&
    (data.config?.sourceType === 'csv' || data.config?.table || data.config?.dataset || data.config?.sourceType);

  const DbIconComponent = data.config?.dbType ? getDbIcon(data.config.dbType) : null;

  const getDisplayName = () => {
    if (data.config?.sourceConnectionName) {
      return data.config.sourceConnectionName;
    }
    return isConfigured ? 'Configured Data Source' : 'Data Source';
  };

  const getSummary = () => {
    if (!isConfigured) return 'Click to configure data source';

    const config = data.config;
    // Prefer AI-written explanations over user questions so the card
    // describes what the node *does*, not what was asked.
    const explanation =
      config.apiFetchExplanation ||
      config.sourceExplanation ||
      config.sourceSqlExplanation ||
      config.sourceQueryDescription ||
      getLatestUserQuestion(config.chat);
    if (explanation) {
      return explanation.length > 100 ? explanation.slice(0, 100) + '...' : explanation;
    }

    if (config.sourceTable) {
      return `Loading data from ${config.sourceTable}`;
    }

    if (config.dataset) {
      return `Loading dataset: ${config.sourceDataset}`;
    }

    return 'Data source configured';
  };

  const latestCodes = extractLatestCodes(data.config?.chat);

  return (
    <div
      style={{
        width: 264,
        background: '#fff',
        border: `1px solid ${selected ? COLOR : BORDER}`,
        borderLeft: `3px solid ${COLOR}`,
        borderRadius: 6,
        boxShadow: selected
          ? `0 0 0 3px ${COLOR}1a, 0 4px 16px rgba(0,0,0,0.12)`
          : '0 1px 4px rgba(0,0,0,0.07)',
        position: 'relative',
        userSelect: 'none',
        fontFamily: "'Inter',-apple-system,sans-serif",
        opacity: isConfigured ? 1 : 0.9,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: COLOR,
          border: '2px solid #fff',
          width: 10,
          height: 10,
          left: -6,
          boxShadow: `0 0 0 1px ${COLOR}44`,
        }}
      />

      {/* Header */}
      <div style={{
        padding: '7px 10px',
        borderBottom: '1px solid #f0f2f5',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
      }}>
        {DbIconComponent ? (
          <DbIconComponent style={{ width: 12, height: 12, fill: COLOR }} />
        ) : (
          <DatabaseOutlined style={{ fontSize: 12, color: COLOR }} />
        )}
        <span style={{
          fontSize: 9,
          fontFamily: MONO,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: COLOR,
          textTransform: 'uppercase',
        }}>
          DATA SOURCE
        </span>
        <div style={{
          marginLeft: 'auto',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: isConfigured ? GREEN : BORDER,
        }} />
      </div>

      {/* Body */}
      <div style={{ padding: '8px 10px' }}>
        <div style={{
          fontSize: 12,
          fontWeight: 600,
          color: TEXT,
          marginBottom: 4,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {getDisplayName()}
        </div>
        <div style={{
          fontSize: 11,
          color: MUTED,
          lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {getSummary()}
        </div>
      </div>

      <ExpandableCodes codes={latestCodes} />

      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: COLOR,
          border: '2px solid #fff',
          width: 10,
          height: 10,
          right: -6,
          boxShadow: `0 0 0 1px ${COLOR}44`,
        }}
      />
    </div>
  );
};

export default DataSourceNode;
