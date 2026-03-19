# RelationshipGraph
A canvas-based relationship graph for Obsidian that treats notes as nodes and lets you visually create, edit, and navigate connections between them.

This is not a tag system, and not the built-in graph view. It’s a manual, spatial graph you control directly.

## What it does

This plugin creates a dedicated graph view where:

- Each node represents a Markdown note

- Nodes are positioned in 2D space and persist their coordinates in frontmatter

- Edges represent relationships between notes and are stored separately in JSON

- Everything is interactive: click, drag, connect, rename, delete

- Nodes are real files. The graph is just a visual layer on top.

## Node Scope (Read This Before You Get Confused)

This plugin does not pull in your entire vault. Only notes inside the configured node folder (default: GraphNodes) exist in the graph.

That’s intentional. If it scanned everything:

it would inject metadata into random notes

your graph would turn into visual noise

performance would tank on large vaults

So instead, it works like a controlled sandbox:

- you create nodes → files are created for you

- those files are the graph

- everything else is ignored

If you don’t see a note in the graph, it’s because it isn’t a node.
