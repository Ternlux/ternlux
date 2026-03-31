import React from 'react';
import { Card, Typography } from 'antd';
import { 
  DatabaseOutlined, 
  SettingOutlined, 
  MergeOutlined, 
  ExportOutlined 
} from '@ant-design/icons';

const { Text } = Typography;

const NodeTypePanel = () => {
  const onDragStart = (event, nodeType) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const nodeTypes = [
    {
      type: 'dataSource',
      label: 'Data Source',
      icon: <DatabaseOutlined />,
      description: 'Connect to data sources',
      className: 'data-source'
    },
    {
      type: 'transformer',
      label: 'Transformer',
      icon: <SettingOutlined />,
      description: 'Transform and filter data',
      className: 'transformer'
    },
    {
      type: 'join',
      label: 'Join',
      icon: <MergeOutlined />,
      description: 'Join multiple data sources',
      className: 'join'
    },
    {
      type: 'output',
      label: 'Output',
      icon: <ExportOutlined />,
      description: 'Define output destination',
      className: 'output'
    }
  ];

  return (
    <Card 
      title="Node Types" 
      size="small" 
      className="node-types-panel"
      style={{ width: '220px' }}
    >
      <Text type="secondary" style={{ fontSize: '12px', display: 'block', marginBottom: '12px' }}>
        Drag nodes to the canvas to build your workflow
      </Text>
      
      {nodeTypes.map((nodeType) => (
        <div
          key={nodeType.type}
          className={`draggable-node ${nodeType.className}`}
          onDragStart={(event) => onDragStart(event, nodeType.type)}
          draggable
        >
          {nodeType.icon}
          <div>
            <div style={{ fontWeight: '500', fontSize: '13px' }}>
              {nodeType.label}
            </div>
            <div style={{ fontSize: '11px', color: '#666', lineHeight: '1.2' }}>
              {nodeType.description}
            </div>
          </div>
        </div>
      ))}
    </Card>
  );
};

export default NodeTypePanel;