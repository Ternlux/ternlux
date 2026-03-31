/**
 * Utility functions for workflow processing
 */

/**
 * Generate execution order using DFS logic, including disconnected nodes
 * @param {Array} workflowNodes - Array of workflow nodes
 * @param {Array} workflowEdges - Array of workflow edges
 * @param {string} startNodeId - ID of the start node
 * @returns {Array} - Array of node IDs in execution order
 */
export const getNodeExecutionOrder = (workflowNodes, workflowEdges, startNodeId) => {
  const executionOrder = [];
  const processed = new Set();

  const dfs = (nodeId) => {
    if (processed.has(nodeId)) {
      return;
    }

    processed.add(nodeId);
    executionOrder.push(nodeId);

    // Find all edges that start from this node
    const outgoingEdges = workflowEdges.filter(edge => edge.source === nodeId);

    for (const edge of outgoingEdges) {
      const targetNodeId = edge.target;

      // Check if all input nodes for the target have been processed
      const incomingEdges = workflowEdges.filter(e => e.target === targetNodeId);
      const allInputsReady = incomingEdges.every(e => processed.has(e.source));

      if (allInputsReady) {
        dfs(targetNodeId);
      }
    }
  };

  // Start DFS from the start node
  dfs(startNodeId);

  // Add any disconnected nodes that weren't reached by DFS
  const allNodeIds = new Set(workflowNodes.map(node => node.id));
  const unprocessedNodes = [...allNodeIds].filter(nodeId => !processed.has(nodeId));
  
  // Add disconnected nodes at the end (except output nodes which should stay last)
  const disconnectedOutputs = [];
  const disconnectedOthers = [];
  
  unprocessedNodes.forEach(nodeId => {
    const node = workflowNodes.find(n => n.id === nodeId);
    if (node && node.type === 'output') {
      disconnectedOutputs.push(nodeId);
    } else {
      disconnectedOthers.push(nodeId);
    }
  });
  
  // Add other disconnected nodes before output nodes
  executionOrder.push(...disconnectedOthers);
  executionOrder.push(...disconnectedOutputs);
  
  console.log('DFS execution order:', executionOrder, 'processed:', processed.size, 'total nodes:', allNodeIds.size);
  
  return executionOrder;
};

/**
 * Generate execution steps from workflow nodes
 * @param {Array} workflowNodes - Array of workflow nodes
 * @param {Array} workflowEdges - Array of workflow edges
 * @returns {Array} - Array of execution step objects
 */
export const generateStepsFromNodes = (workflowNodes, workflowEdges) => {
  // Find start node
  const startNode = workflowNodes.find(node => node.type === 'start');
  if (!startNode) return [];

  // Get execution order using DFS logic
  const nodeIds = getNodeExecutionOrder(workflowNodes, workflowEdges, startNode.id);
  
  // Convert to execution steps
  let steps = nodeIds.map((nodeId, index) => {
    const node = workflowNodes.find(n => n.id === nodeId);
    if (!node) return null;

    // Get the appropriate label (node_name first, then connectionName, then fallback)
    const nodeLabel = node.data?.config?.node_name || node.data?.config?.connectionName || node.data?.label || 'Unnamed';
    
    // Get the appropriate description based on node type
    let description = '';
    if (node.type === 'transformer') {
      description = node.data?.config?.transformationRequest || '';
    } else if (node.type === 'join') {
      description = node.data?.config?.joinDescription || '';
    } else {
      description = node.data?.config?.description || '';
    }

    return {
      id: `step-${node.id}`,
      nodeId: node.id,
      nodeType: node.type,
      nodeLabel: nodeLabel,
      customName: '',
      description: description,
      order: index,
      config: node.data?.config || {}
    };
  }).filter(Boolean); // Remove any null entries

  // Ensure start node is first and output node is last
  const startIndex = steps.findIndex(step => step.nodeType === 'start');
  const outputIndex = steps.findIndex(step => step.nodeType === 'output');

  if (startIndex > 0) {
    // Move start to beginning
    const startStep = steps.splice(startIndex, 1)[0];
    steps.unshift(startStep);
  }

  if (outputIndex !== -1 && outputIndex < steps.length - 1) {
    // Move output to end
    const outputStep = steps.splice(outputIndex, 1)[0];
    steps.push(outputStep);
  }

  // Update order property after reordering
  return steps.map((step, index) => ({
    ...step,
    order: index
  }));
};