import React from 'react';
import { Handle, Position } from 'reactflow';
import { MergeOutlined } from '@ant-design/icons';
import { ExpandableCodes, extractLatestCodes, describeNode, nodeDisplayName, truncate } from './nodeCardShared';

const COLOR = '#d97706';
const MONO = "'JetBrains Mono', monospace";
const TEXT = '#111827';
const MUTED = '#5a6678';
const BORDER = '#e2e6eb';
const GREEN = '#059669';

const JoinNode = ({ data, selected }) => {
  // Matches how the Data Preview decides a join is configured. The chat saves
  // the generated function as `transformFunction`; `javascriptFunction` is
  // only the AI's field name and never lands on the config.
  const config = data.config || {};
  const isConfigured = !!(
    config.sourcesConfig ||
    config.joinSql ||
    config.targetSql ||
    config.aggregationPipeline ||
    config.transformFunction ||
    config.javascriptFunction
  );

  // Named by nodeDisplayName — see TransformerNode for why the config, not
  // the creation-time label, is what names a node.
  const getDisplayName = () => nodeDisplayName('join', data, 'Join');

  const getSummary = () => {
    if (!isConfigured) return 'Click to configure join operation';

    // Which sources are joined and where the result lands, named from the
    // config — the same rows the Data Preview's Details tab lists.
    const described = describeNode('join', config);
    if (described) return described;

    const explanation = config.explanation || config.joinRequest || config.joinDescription;
    if (explanation) return truncate(explanation);

    if (config.sourcesConfig?.length > 0) {
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
