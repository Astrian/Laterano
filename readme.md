# Laterano

> Lateranians love sweets, and it is said that a qualified Lateran knows how to make at least twenty kinds of desserts. 
> 
> Lateranians have even created the unique dessert “Cactus Tart,” which is loved by the Pope.
> 
> [ref](https://prts.wiki/w/%E6%B3%B0%E6%8B%89%E5%A4%A7%E5%85%B8:%E5%9C%B0%E7%90%86/%E6%8B%89%E7%89%B9%E5%85%B0#:~:text=%E6%8B%89%E7%89%B9%E5%85%B0%E4%BA%BA,%E5%93%81%EF%BC%8C%E5%8F%97%E5%88%B0%E6%95%99%E5%AE%97%E5%96%9C%E7%88%B1%E3%80%82)

*Laterano* is a front-end framework based on the features of the [native support of vanilla-favoured Web Component feature](https://developer.mozilla.org/en-US/docs/Web/API/Web_components). It allows you to adapt modern MVVM development workflows with the features, abilities, and benefits of Shadow DOM, including native componentized support, styling management, and more.

**Note:** Laterano was developed for learning purposes originally and is still under active development. We do not recommend using it inside a production environment.

## How to use

1. Create a vanilla front-end project with Vite. Input `npm init vite` inside the terminal, then choose “Vanilla” and “TypeScript”
2. Install Laterano through npm
3. Define your component and use it inside your HTML
4. Done!

Here is a sample code:

```ts
import defineComponent from 'laterano'
import './style.css'

defineComponent({
  tag: 'x-todolist',
  template: `
    <div class="container">
      <h1>Todo List</h1>
      <input type="text" placeholder="Add a new todo" %connect="todoinput" @keyup="e => this.triggerFunc('keyDownListener', e)" />

      <ul class="todo-list">
        <li %if="todos.length === 0">
          <span class="empty">
            No todos yet! Add one above.
          </span>
        </li>
        <li %for="item in todos" %key="item.time" class="todo-item">
          <button @click="this.triggerFunc('removeTodo', item.time)">
            {{ item.name }}
          </button>
        </li>
      </ul>

      
    </div>
  `,
  style: `
    div.container {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
      background-color: #f0f0f0;
    }
    div.container input {
      width: 20rem;
      padding: 0.75rem;
      margin-bottom: 1.5rem;
      border: 1px solid #ccc;
      border-radius: 0.5rem;
      font-size: 1rem;
    }
    div.container input:focus {
      border-color: #007bff;
      outline: none;
    }

    div.container ul.todo-list {
      list-style-type: none;
      padding: 0;
      width: 20rem;
      border: 1px solid #ccc;
      border-radius: 0.5rem;
      overflow: hidden;
    }
    div.container ul.todo-list li {
      padding: 10px;
      border-bottom: 1px solid #ccc;
      background-color: #fff;
    }
    div.container ul.todo-list li.todo-item {
      cursor: pointer;
    }
    div.container ul.todo-list li:hover {
      background-color: #f9f9f9;
    }
    div.container ul.todo-list li:last-child {
      border-bottom: none;
    }

    div.container ul.todo-list li button {
      background: none;
      border: none;
      width: 100%;
      text-align: left;
      font-size: 1rem;
      cursor: pointer;
    }

    span.empty {
      color: #999;
      cursor: default;
    }
  `,
  states: {
    todos: [
      
    ],
    todoinput: ''
  },
  funcs: {
    keyDownListener: function (event: KeyboardEvent) {
      if(event.key !== 'Enter') return
      if ((this as any).getState('todoinput') === "") return
      this.setState("todos", [
        ...(this as any).getState('todos'),
        {
          name: (this as any).getState('todoinput'),
          time: new Date().getTime()
        }
      ])
      this.setState("todoinput", "")
    },
    removeTodo: function (time: number) {
      const todos = (this as any).getState('todos')
      let list = structuredClone(todos)
      const index = list.findIndex((item: { time: number }) => item.time === time)
      if (index !== -1) {
        list.splice(index, 1)
        this.setState('todos', list)
      }

    }
  }
})
```

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + TS</title>
  </head>
  <body>
    <div id="app">
      <div>
        <x-todolist></x-todolist>
      </div>
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```