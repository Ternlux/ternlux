import { HyperFormula } from 'hyperformula';

class HyperFormulaService {
  constructor() {
    this.hf = null;
    this.initialize();
  }

  initialize() {
    this.hf = HyperFormula.buildEmpty({
      licenseKey: 'gpl-v3'
    });
  }

  // Transform data using filter operation
  filterData(data, condition) {
    try {
      // Parse the condition and apply filter
      // For simplicity, we'll handle basic conditions like "column > value"
      const filtered = data.filter(row => {
        return this.evaluateCondition(row, condition);
      });
      
      return {
        success: true,
        data: filtered,
        rowsProcessed: filtered.length,
        originalRows: data.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        data: []
      };
    }
  }

  // Update column values using HyperFormula
  updateColumn(data, columnName, expression) {
    try {
      const updatedData = data.map(row => {
        const newRow = { ...row };
        
        // Replace column references in expression with actual values
        let processedExpression = expression;
        Object.keys(row).forEach(key => {
          const regex = new RegExp(`\\b${key}\\b`, 'g');
          processedExpression = processedExpression.replace(regex, row[key]);
        });

        // Use HyperFormula to evaluate the expression
        try {
          this.hf.addSheet('temp');
          const sheetId = this.hf.getSheetId('temp');
          this.hf.setCellContents({ col: 0, row: 0, sheet: sheetId }, `=${processedExpression}`);
          const result = this.hf.getCellValue({ col: 0, row: 0, sheet: sheetId });
          
          newRow[columnName] = result;
          this.hf.removeSheet(sheetId);
        } catch (formulaError) {
          // If formula fails, keep original value
          console.warn('Formula evaluation failed:', formulaError);
        }
        
        return newRow;
      });

      return {
        success: true,
        data: updatedData,
        rowsProcessed: updatedData.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        data: data
      };
    }
  }

  // Delete column from dataset
  deleteColumn(data, columnName) {
    try {
      const updatedData = data.map(row => {
        const newRow = { ...row };
        delete newRow[columnName];
        return newRow;
      });

      return {
        success: true,
        data: updatedData,
        rowsProcessed: updatedData.length,
        deletedColumn: columnName
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        data: data
      };
    }
  }

  // Add new column with formula
  addColumn(data, newColumnName, expression) {
    try {
      const updatedData = data.map(row => {
        const newRow = { ...row };
        
        // Replace column references in expression with actual values
        let processedExpression = expression;
        Object.keys(row).forEach(key => {
          const regex = new RegExp(`\\b${key}\\b`, 'g');
          processedExpression = processedExpression.replace(regex, row[key]);
        });

        // Use HyperFormula to evaluate the expression
        try {
          this.hf.addSheet('temp');
          const sheetId = this.hf.getSheetId('temp');
          this.hf.setCellContents({ col: 0, row: 0, sheet: sheetId }, `=${processedExpression}`);
          const result = this.hf.getCellValue({ col: 0, row: 0, sheet: sheetId });
          
          newRow[newColumnName] = result;
          this.hf.removeSheet(sheetId);
        } catch (formulaError) {
          // If formula fails, set default value
          newRow[newColumnName] = null;
          console.warn('Formula evaluation failed:', formulaError);
        }
        
        return newRow;
      });

      return {
        success: true,
        data: updatedData,
        rowsProcessed: updatedData.length,
        addedColumn: newColumnName
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        data: data
      };
    }
  }

  // Join two datasets
  joinData(leftData, rightData, leftKey, rightKey, joinType = 'inner') {
    try {
      let joinedData = [];

      switch (joinType) {
        case 'inner':
          joinedData = this.innerJoin(leftData, rightData, leftKey, rightKey);
          break;
        case 'left':
          joinedData = this.leftJoin(leftData, rightData, leftKey, rightKey);
          break;
        case 'right':
          joinedData = this.rightJoin(leftData, rightData, leftKey, rightKey);
          break;
        case 'full':
          joinedData = this.fullOuterJoin(leftData, rightData, leftKey, rightKey);
          break;
        default:
          throw new Error('Unsupported join type');
      }

      return {
        success: true,
        data: joinedData,
        rowsProcessed: joinedData.length,
        leftRows: leftData.length,
        rightRows: rightData.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        data: []
      };
    }
  }

  // Helper method to evaluate simple conditions
  evaluateCondition(row, condition) {
    try {
      // Handle basic conditions like "age > 30", "name = 'John'", etc.
      const operators = ['>=', '<=', '!=', '=', '>', '<'];
      let operator, leftOperand, rightOperand;

      for (const op of operators) {
        if (condition.includes(op)) {
          const parts = condition.split(op).map(p => p.trim());
          if (parts.length === 2) {
            operator = op;
            leftOperand = parts[0];
            rightOperand = parts[1].replace(/['"]/g, ''); // Remove quotes
            break;
          }
        }
      }

      if (!operator) return true; // If no valid operator, include row

      const leftValue = row[leftOperand];
      let rightValue = rightOperand;

      // Try to convert to number if possible
      if (!isNaN(rightValue)) {
        rightValue = parseFloat(rightValue);
      }

      switch (operator) {
        case '>':
          return leftValue > rightValue;
        case '<':
          return leftValue < rightValue;
        case '>=':
          return leftValue >= rightValue;
        case '<=':
          return leftValue <= rightValue;
        case '=':
          return leftValue == rightValue;
        case '!=':
          return leftValue != rightValue;
        default:
          return true;
      }
    } catch (error) {
      console.warn('Condition evaluation failed:', error);
      return true;
    }
  }

  // Join implementations
  innerJoin(left, right, leftKey, rightKey) {
    return left.filter(leftRow => 
      right.some(rightRow => leftRow[leftKey] === rightRow[rightKey])
    ).map(leftRow => {
      const rightRow = right.find(r => r[rightKey] === leftRow[leftKey]) || {};
      return { ...leftRow, ...rightRow };
    });
  }

  leftJoin(left, right, leftKey, rightKey) {
    return left.map(leftRow => {
      const rightRow = right.find(r => r[rightKey] === leftRow[leftKey]) || {};
      return { ...leftRow, ...rightRow };
    });
  }

  rightJoin(left, right, leftKey, rightKey) {
    return right.map(rightRow => {
      const leftRow = left.find(l => l[leftKey] === rightRow[rightKey]) || {};
      return { ...leftRow, ...rightRow };
    });
  }

  fullOuterJoin(left, right, leftKey, rightKey) {
    const leftJoined = this.leftJoin(left, right, leftKey, rightKey);
    const rightOnly = right.filter(rightRow => 
      !left.some(leftRow => leftRow[leftKey] === rightRow[rightKey])
    );
    return [...leftJoined, ...rightOnly];
  }

  // Generate sample data for testing
  generateSampleData(type = 'customers') {
    switch (type) {
      case 'customers':
        return [
          { id: 1, name: 'John Doe', email: 'john@example.com', age: 30, city: 'New York' },
          { id: 2, name: 'Jane Smith', email: 'jane@example.com', age: 25, city: 'Los Angeles' },
          { id: 3, name: 'Bob Johnson', email: 'bob@example.com', age: 35, city: 'Chicago' },
          { id: 4, name: 'Alice Brown', email: 'alice@example.com', age: 28, city: 'Houston' },
          { id: 5, name: 'Charlie Wilson', email: 'charlie@example.com', age: 32, city: 'Phoenix' }
        ];
      case 'orders':
        return [
          { order_id: 101, customer_id: 1, amount: 150.00, product: 'Laptop' },
          { order_id: 102, customer_id: 2, amount: 75.50, product: 'Mouse' },
          { order_id: 103, customer_id: 1, amount: 299.99, product: 'Monitor' },
          { order_id: 104, customer_id: 3, amount: 45.00, product: 'Keyboard' },
          { order_id: 105, customer_id: 4, amount: 199.99, product: 'Tablet' }
        ];
      default:
        return [];
    }
  }
}

export default new HyperFormulaService();