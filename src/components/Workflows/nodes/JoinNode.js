import React from 'react';
import { Handle, Position } from 'reactflow';
import { MergeOutlined } from '@ant-design/icons';
import { ExpandableCodes, extractLatestCodes, getLatestUserQuestion } from './nodeCardShared';

const COLOR = '#d97706';
const MONO = "'JetBrains Mono', monospace";
const TEXT = '#111827';
const MUTED = '#5a6678';
const BORDER = '#e2e6eb';
const GREEN = '#059669';

const JoinNode = ({ data, selected }) => {
  const isConfigured = !!(data.config?.sourcesConfig || data.config?.joinSql || data.config?.javascriptFunction);

  const getDisplayName = () => {
    const config = data.config;

    if (config?.targetTableName) {
      return config.targetTableName;
    }
    if (config?.targetCollection) {
      return config.targetCollection;
    }
    if (config?.node_name) {
      return config.node_name;
    }

    return data.label || 'Join';
  };

  const getSummary = () => {
    if (!isConfigured) return 'Click to configure join operation';

    const config = data.config;

    const explanation = config?.explanation || getLatestUserQuestion(config?.chat);
    if (explanation) {
      return explanation.length > 100 ? explanation.slice(0, 100) + '...' : explanation;
    }

    if (config?.sourcesConfig && config.sourcesConfig.length > 0) {
      const sourceCount = config.sourcesConfig.length;
      const targetName = config.targetTableName || config.targetCollection || 'result';
      return `Joining ${sourceCount} source${sourceCount > 1 ? 's' : ''} into ${targetName}`;
    }

    return 'Join operation configured';
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
        id="input1"
        style={{
          background: COLOR,
          border: '2px solid #fff',
          width: 10,
          height: 10,
          left: -6,
          top: '30%',
          boxShadow: `0 0 0 1px ${COLOR}44`,
        }}
      />

      <Handle
        type="target"
        position={Position.Left}
        id="input2"
        style={{
          background: COLOR,
          border: '2px solid #fff',
          width: 10,
          height: 10,
          left: -6,
          top: '70%',
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
        <MergeOutlined style={{ fontSize: 12, color: COLOR }} />
        <span style={{
          fontSize: 9,
          fontFamily: MONO,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: COLOR,
          textTransform: 'uppercase',
        }}>
          JOIN
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

export default JoinNode;
