/**
 * Utility functions for workflow processing
 */

import { nodeDisplayName } from '../components/Workflows/nodes/nodeCardShared';

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

    // One naming rule for every surface — see nodeDisplayName. A node built
    // through chat never gets its creation-time label rewritten, so the config
    // is what names it.
    const nodeLabel = nodeDisplayName(node.type, node.data, 'Unnamed');
    
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

  // Ensure start node is first. Output nodes stay where the graph order put
  // them: a workflow can have several, and an output may legitimately sit
  // mid-pipeline, so nothing is forced to the end.
  const startIndex = steps.findIndex(step => step.nodeType === 'start');

  if (startIndex > 0) {
    // Move start to beginning
    const startStep = steps.splice(startIndex, 1)[0];
    steps.unshift(startStep);
  }

  // Update order property after reordering
  return steps.map((step, index) => ({
    ...step,
    order: index
  }));
};