import React, { useState } from 'react';
import { Layout, Tabs, Typography } from 'antd';
import { 
  ApiOutlined, 
  PlayCircleOutlined,
  ApartmentOutlined
} from '@ant-design/icons';
import WorkflowsTab from './WorkflowsTab';
import ConnectionsTab from './ConnectionsTab';
import ExecutionTab from './ExecutionTab';
import './Workflows.css';

const { Header, Content } = Layout;
const { Title } = Typography;
const { TabPane } = Tabs;

const Workflows = () => {
  const [activeTab, setActiveTab] = useState('workflows');

  const tabItems = [
    {
      key: 'workflows',
      label: (
        <span style={{ display: 'flex', alignItems: 'center' }}>
          <ApartmentOutlined style={{ marginRight: '8px' }} />
          Workflows
        </span>
      ),
      children: <WorkflowsTab />
    },
    {
      key: 'connections',
      label: (
        <span>
          <ApiOutlined />
          Connections
        </span>
      ),
      children: <ConnectionsTab />
    },
    {
      key: 'execution',
      label: (
        <span>
          <PlayCircleOutlined />
          Execution
        </span>
      ),
      children: <ExecutionTab />
    }
  ];

  return (
    <Layout style={{ minHeight: '100vh', overflowY: 'scroll' }}>

      <Content style={{ padding: '24px'}}>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          type="card"
          size="large"
          items={tabItems}
          className="workflows-tabs"
        />
      </Content>
    </Layout>
  );
};

export default Workflows;