import assert from 'node:assert/strict';
import { visibleTodos } from './filter.js';

const todos = [{ title: 'Try Loom', completed: false }, { title: 'Read the README', completed: true }];
assert.deepEqual(visibleTodos(todos), todos);
assert.deepEqual(visibleTodos([]), []);
console.log('PASS: all todos and empty lists');
