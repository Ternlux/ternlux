import React from 'react';
import { Handle, Position } from 'reactflow';
import { MailOutlined, ExportOutlined } from '@ant-design/icons';
import { ExpandableCodes, extractLatestCodes } from './nodeCardShared';

const COLOR = '#db2777';
const MONO = "'JetBrains Mono', monospace";
const TEXT = '#111827';
const MUTED = '#5a6678';
const BORDER = '#e2e6eb';
const GREEN = '#059669';

const OutputNode = ({ data, selected }) => {
  const isConfigured = !!(data.config?.outputSettings?.outputType);

  const getDisplayName = () => {
    const outputSettings = data.config?.outputSettings;
    if (!outputSettings?.outputType) {
      return 'Output';
    }

    if (outputSettings.outputType === 'local') {
      const format = outputSettings.format?.toUpperCase() || 'FILE';
      return `Export to ${format}`;
    } else if (outputSettings.outputType === 'connection') {
      return outputSettings.tableName || 'Database Export';
    }

    return 'Output';
  };

  const getOutputIcon = () => {
    const outputSettings = data.config?.outputSettings;

    if (outputSettings?.outputType === 'connection') {
      return <MailOutlined style={{ fontSize: 12, color: COLOR }} />;
    }

    return <ExportOutlined style={{ fontSize: 12, color: COLOR }} />;
  };

  const getSummary = () => {
    if (!isConfigured) return 'Click to configure output';

    const outputSettings = data.config?.outputSettings;

    if (outputSettings.outputType === 'local') {
      const format = outputSettings.format?.toUpperCase() || 'file';
      const fileName = outputSettings.savePath ? outputSettings.savePath.split('/').pop() : 'output file';
      return `Export data to ${format} file: ${fileName}`;
    } else if (outputSettings.outputType === 'connection') {
      const connectionName = data.config?.sourceConnectionName || 'database';
      return `Insert data into ${outputSettings.tableName} (${connectionName})`;
    }

    return 'Output configured';
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
        {getOutputIcon()}
        <span style={{
          fontSize: 9,
          fontFamily: MONO,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: COLOR,
          textTransform: 'uppercase',
        }}>
          OUTPUT
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
    </div>
  );
};

export default OutputNode;
