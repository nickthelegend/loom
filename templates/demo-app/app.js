import { visibleTodos } from './filter.js';

const todos = [{ title: 'Try Loom', completed: false }, { title: 'Explore the shared memory', completed: true }];
const form = document.querySelector('form');
const filter = document.querySelector('#filter');
function render() {
  const list = document.querySelector('ul');
  list.replaceChildren();
  for (const todo of visibleTodos(todos, filter.value)) {
    const item = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = todo.completed;
    checkbox.onchange = () => { todo.completed = checkbox.checked; render(); };
    label.append(checkbox, document.createTextNode(todo.title));
    item.append(label);
    list.append(item);
  }
  document.querySelector('#count').textContent = `${todos.filter(todo => !todo.completed).length} left`;
}
form.onsubmit = event => {
  event.preventDefault();
  const input = form.querySelector('input');
  if (input.value.trim()) todos.push({ title: input.value.trim(), completed: false });
  input.value = '';
  render();
};
filter.onchange = render;
render();
