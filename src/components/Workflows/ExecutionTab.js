import React, { useState, useEffect } from 'react';
import { Card, List, Typography, Space, Tag, Button, Modal, Progress, Collapse, Spin, message, Statistic, Row, Col } from 'antd';
import { 
  PlayCircleOutlined, 
  CheckCircleOutlined, 
  CloseCircleOutlined, 
  LoadingOutlined,
  EyeOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
  CalendarOutlined,
  TableOutlined,
  UserOutlined
} from '@ant-design/icons';
import moment from 'moment';
import axios from 'axios';

const { Title, Text } = Typography;
const { Panel } = Collapse;

const ExecutionTab = () => {
  const [executions, setExecutions] = useState([]);
  const [selectedExecution, setSelectedExecution] = useState(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 10,
    total: 0,
    hasMore: false
  });

  // Fetch executions from API
  const fetchExecutions = async (page = 1, showLoading = true) => {
    if (showLoading) setLoading(true);
    
    try {
      const token = localStorage.getItem('auth-token');
      if (!token) {
        message.error('Authentication required');
        return;
      }

      const offset = (page - 1) * pagination.limit;
      const response = await axios.get(`/workflow/executions?limit=${pagination.limit}&offset=${offset}`, {
        headers: { "auth-token": token }
      });

      if (response.data.success) {
        const { data: newExecutions, pagination: newPagination } = response.data;
        setExecutions(newExecutions || []);
        setPagination(prev => ({ ...prev, ...newPagination }));
      } else {
        message.error('Failed to load executions');
        setExecutions([]);
      }
    } catch (error) {
      console.error('Error fetching executions:', error);
      if (error.response?.status === 404) {
        message.warning('Execution endpoint not found. Using sample data for now.');
        // Set sample data for development
        setExecutions([]);
      } else {
        message.error('Failed to load executions');
      }
      setExecutions([]);
    } finally {
      setLoading(false);
    }
  };

  // Fetch execution statistics
  const fetchStats = async () => {
    try {
      const token = localStorage.getItem('auth-token');
      if (!token) return;

      const response = await axios.get('/workflow/executions/stats', {
        headers: { "auth-token": token }
      });

      if (response.data.success) {
        setStats(response.data.data);
      }
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  useEffect(() => {
    fetchExecutions();
    fetchStats();
    
    // Set up auto-refresh for running executions
    const interval = setInterval(() => {
      fetchExecutions(pagination.page, false);
    }, 30000); // Refresh every 30 seconds

    return () => clearInterval(interval);
  }, []);

  const getStatusIcon = (status) => {
    switch (status) {
      case 'completed':
        return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
      case 'failed':
        return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
      case 'running':
        return <LoadingOutlined style={{ color: '#1890ff' }} />;
      case 'pending':
        return <ClockCircleOutlined style={{ color: '#d9d9d9' }} />;
      case 'cancelled':
        return <CloseCircleOutlined style={{ color: '#d48806' }} />;
      case 'timeout':
        return <CloseCircleOutlined style={{ color: '#ff7a45' }} />;
      default:
        return <ClockCircleOutlined style={{ color: '#d9d9d9' }} />;
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'completed':
        return 'green';
      case 'failed':
        return 'red';
      case 'running':
        return 'blue';
      case 'pending':
        return 'default';
      case 'cancelled':
        return 'orange';
      case 'timeout':
        return 'volcano';
      default:
        return 'default';
    }
  };

  const formatDuration = (milliseconds) => {
    if (!milliseconds) return 'N/A';
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

  const fetchExecutionDetails = async (executionId) => {
    try {
      const token = localStorage.getItem('auth-token');
      const response = await axios.get(`/workflow/executions/${executionId}`, {
        headers: { "auth-token": token }
      });
      
      if (response.data.success) {
        setSelectedExecution(response.data.data);
        setIsDetailModalOpen(true);
      } else {
        message.error('Failed to load execution details');
      }
    } catch (error) {
      console.error('Error fetching execution details:', error);
      message.error('Failed to load execution details');
    }
  };

  const handleViewDetails = (execution) => {
    fetchExecutionDetails(execution.executionId);
  };

  const handleRefresh = () => {
    fetchExecutions(pagination.page);
    fetchStats();
  };

  return (
    <div className="workflows-container">
      <div className="workflows-header">
        <div>
          <Title level={4} style={{ margin: 0 }}>
            Workflow Executions
          </Title>
          <Text type="secondary">
            Monitor workflow execution history and logs
          </Text>
        </div>
        <Button 
          icon={<ReloadOutlined />} 
          onClick={handleRefresh}
          loading={loading}
        >
          Refresh
        </Button>
      </div>

      {/* Statistics Cards */}
      {stats && (
        <Row gutter={16} style={{ marginBottom: '24px' }}>
          <Col span={6}>
            <Card>
              <Statistic
                title="Total Executions"
                value={stats.totalExecutions}
                prefix={<PlayCircleOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="Completed"
                value={stats.completedExecutions}
                valueStyle={{ color: '#3f8600' }}
                prefix={<CheckCircleOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="Failed"
                value={stats.failedExecutions}
                valueStyle={{ color: '#cf1322' }}
                prefix={<CloseCircleOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="Success Rate"
                value={stats.successRate}
                precision={1}
                suffix="%"
                valueStyle={{ color: '#3f8600' }}
              />
            </Card>
          </Col>
        </Row>
      )}

      <div className="workflows-content">
        {loading ? (
          <div style={{ textAlign: 'center', padding: '50px' }}>
            <Spin size="large" />
            <div style={{ marginTop: '16px' }}>Loading executions...</div>
          </div>
        ) : !executions || executions.length === 0 ? (
          <div className="empty-state">
            <PlayCircleOutlined />
            <Title level={4} type="secondary">
              No executions yet
            </Title>
            <Text type="secondary">
              Workflow executions will appear here once you run your workflows
            </Text>
          </div>
        ) : (
          <div className="workflow-list">
            <List
              dataSource={executions}
              renderItem={(execution) => (
                <List.Item>
                  <Card
                    style={{ width: '100%' }}
                    title={
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Space>
                          {getStatusIcon(execution.status)}
                          <span>{execution.workflowName || execution.workflowId}</span>
                        </Space>
                        <Space>
                          <Tag color={getStatusColor(execution.status)} className={`execution-status ${execution.status}`}>
                            {execution.status.toUpperCase()}
                          </Tag>
                          <Button 
                            type="text" 
                            icon={<EyeOutlined />} 
                            onClick={() => handleViewDetails(execution)}
                          >
                            View Details
                          </Button>
                        </Space>
                      </div>
                    }
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                      <div>
                        <Text strong>Started: </Text>
                        <Text>
                          <CalendarOutlined style={{ marginRight: '4px' }} />
                          {moment(execution.startTime).format('MMM DD, YYYY HH:mm')}
                        </Text>
                      </div>
                      <div>
                        <Text strong>Duration: </Text>
                        <Text>{formatDuration(execution.duration)}</Text>
                      </div>
                      <div>
                        <Text strong>Records: </Text>
                        <Text>
                          <TableOutlined style={{ marginRight: '4px' }} />
                          {execution.results?.totalRecordsProcessed?.toLocaleString() || 0}
                        </Text>
                      </div>
                      <div>
                        <Text strong>User: </Text>
                        <Text>
                          <UserOutlined style={{ marginRight: '4px' }} />
                          {execution.username || 'Unknown'}
                        </Text>
                      </div>
                    </div>

                    {execution.status === 'running' && execution.progress && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
                          <Text strong>Progress: </Text>
                          <Text style={{ marginLeft: '8px' }}>{execution.progress.currentStage}</Text>
                        </div>
                        <Progress 
                          percent={execution.progress.percentage || 0}
                          status="active" 
                          strokeColor="#1890ff"
                          format={(percent) => `${percent}% (${execution.progress.processedNodes}/${execution.progress.totalNodes} nodes)`}
                        />
                        {execution.progress.currentNode && (
                          <Text type="secondary" style={{ fontSize: '12px' }}>
                            Current Node: {execution.progress.currentNode}
                          </Text>
                        )}
                      </div>
                    )}

                    {execution.status === 'failed' && execution.error && (
                      <div style={{ 
                        background: '#fff2f0', 
                        border: '1px solid #ffccc7', 
                        borderRadius: '4px', 
                        padding: '8px', 
                        marginTop: '8px',
                        color: '#ff4d4f'
                      }}>
                        <Text strong>Error: </Text>
                        <Text>{execution.error.message || 'Unknown error occurred'}</Text>
                      </div>
                    )}

                    {execution.outputTableName && (
                      <div style={{ 
                        background: '#f6ffed', 
                        border: '1px solid #b7eb8f', 
                        borderRadius: '4px', 
                        padding: '8px', 
                        marginTop: '8px',
                        color: '#52c41a'
                      }}>
                        <Text strong>Output Table: </Text>
                        <Text code>{execution.outputTableName}</Text>
                      </div>
                    )}
                  </Card>
                </List.Item>
              )}
            />
          </div>
        )}
      </div>

      <Modal
        title={`Execution Details - ${selectedExecution?.workflowName || selectedExecution?.workflowId || 'Loading...'}`}
        open={isDetailModalOpen}
        onCancel={() => setIsDetailModalOpen(false)}
        footer={null}
        width={900}
      >
        {selectedExecution && (
          <div>
            <div style={{ marginBottom: '24px' }}>
              <Row gutter={16}>
                <Col span={8}>
                  <div>
                    <Text strong>Status: </Text>
                    <Tag color={getStatusColor(selectedExecution.status)}>
                      {selectedExecution.status.toUpperCase()}
                    </Tag>
                  </div>
                </Col>
                <Col span={8}>
                  <div>
                    <Text strong>Duration: </Text>
                    <Text>{formatDuration(selectedExecution.duration)}</Text>
                  </div>
                </Col>
                <Col span={8}>
                  <div>
                    <Text strong>Records: </Text>
                    <Text>{selectedExecution.results?.totalRecordsProcessed?.toLocaleString() || 0}</Text>
                  </div>
                </Col>
              </Row>
              <Row gutter={16} style={{ marginTop: '12px' }}>
                <Col span={8}>
                  <div>
                    <Text strong>Started: </Text>
                    <Text>{moment(selectedExecution.startTime).format('MMM DD, YYYY HH:mm:ss')}</Text>
                  </div>
                </Col>
                <Col span={8}>
                  <div>
                    <Text strong>Trigger: </Text>
                    <Text>{selectedExecution.trigger?.type || 'Unknown'}</Text>
                  </div>
                </Col>
                <Col span={8}>
                  <div>
                    <Text strong>User: </Text>
                    <Text>{selectedExecution.username || 'Unknown'}</Text>
                  </div>
                </Col>
              </Row>
              {selectedExecution.outputTableName && (
                <Row style={{ marginTop: '12px' }}>
                  <Col span={24}>
                    <div>
                      <Text strong>Output Table: </Text>
                      <Text code>{selectedExecution.outputTableName}</Text>
                    </div>
                  </Col>
                </Row>
              )}
            </div>

            <Collapse defaultActiveKey={['1', '2', '3']}>
              <Panel header={`Node Executions (${selectedExecution.nodeExecutions?.length || 0})`} key="1">
                <List
                  dataSource={selectedExecution.nodeExecutions || []}
                  renderItem={(nodeExecution) => (
                    <List.Item>
                      <div style={{ width: '100%' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                          <Space>
                            {getStatusIcon(nodeExecution.status)}
                            <Text strong>{nodeExecution.nodeName || nodeExecution.nodeId}</Text>
                          </Space>
                          <Text type="secondary">{formatDuration(nodeExecution.duration)}</Text>
                        </div>
                        {nodeExecution.error && (
                          <Text type="danger">Error: {nodeExecution.error.message}</Text>
                        )}
                        {nodeExecution.metrics && (
                          <div style={{ marginTop: '4px' }}>
                            <Space>
                              <Text type="secondary">Processed: {nodeExecution.metrics.recordsProcessed || 0}</Text>
                              <Text type="secondary">Success: {nodeExecution.metrics.recordsSuccess || 0}</Text>
                              <Text type="secondary">Failed: {nodeExecution.metrics.recordsFailed || 0}</Text>
                            </Space>
                          </div>
                        )}
                      </div>
                    </List.Item>
                  )}
                />
              </Panel>
              
              <Panel header={`Execution Logs (${selectedExecution.logs?.length || 0})`} key="2">
                <div style={{ maxHeight: '400px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '12px', background: '#f5f5f5', padding: '12px', borderRadius: '4px' }}>
                  {selectedExecution.logs && selectedExecution.logs.length > 0 ? (
                    selectedExecution.logs.map((log, index) => (
                      <div key={index} style={{ marginBottom: '4px' }}>
                        <Text 
                          style={{ 
                            color: log.level === 'error' ? '#ff4d4f' : log.level === 'warn' ? '#fa8c16' : '#000',
                            fontSize: '12px'
                          }}
                        >
                          [{moment(log.timestamp).format('HH:mm:ss')}] {log.level.toUpperCase()}: {log.message}
                          {log.nodeId && ` (Node: ${log.nodeId})`}
                        </Text>
                      </div>
                    ))
                  ) : (
                    <Text type="secondary">No logs available</Text>
                  )}
                </div>
              </Panel>

              <Panel header="Execution Summary" key="3">
                <div>
                  <Row gutter={16}>
                    <Col span={12}>
                      <div style={{ marginBottom: '12px' }}>
                        <Text strong>Execution Order:</Text>
                        <div style={{ marginTop: '8px' }}>
                          {selectedExecution.executionOrder && selectedExecution.executionOrder.length > 0 ? (
                            selectedExecution.executionOrder.map((nodeId, index) => (
                              <Tag key={index} style={{ marginBottom: '4px' }}>
                                {index + 1}. {nodeId}
                              </Tag>
                            ))
                          ) : (
                            <Text type="secondary">No execution order available</Text>
                          )}
                        </div>
                      </div>
                    </Col>
                    <Col span={12}>
                      <div>
                        <Text strong>Results Summary:</Text>
                        <div style={{ marginTop: '8px' }}>
                          <Text>{selectedExecution.results?.summary || 'No summary available'}</Text>
                        </div>
                        {selectedExecution.results?.outputFiles && selectedExecution.results.outputFiles.length > 0 && (
                          <div style={{ marginTop: '8px' }}>
                            <Text strong>Output Files:</Text>
                            {selectedExecution.results.outputFiles.map((file, index) => (
                              <div key={index} style={{ marginTop: '4px' }}>
                                <Text code>{file.name}</Text> <Text type="secondary">({file.format}, {file.size} records)</Text>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </Col>
                  </Row>
                </div>
              </Panel>
            </Collapse>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default ExecutionTab;