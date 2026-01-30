# Arcium Docs MCP Server

## Overview

The Arcium Docs operates as an **HTTP-based MCP server** (Model Context Protocol) that provides documentation search capabilities for AI assistants like Claude.

**Version:** 1.0.0

## Available Tool

### SearchArciumDocs

Search across the Arcium Docs knowledge base to find relevant information, code examples, API references, and guides.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Your search term |
| `version` | No | Target specific docs version (e.g., 'v0.7') |
| `language` | No | Language code ('zh' for Chinese, 'es' for Spanish; defaults to English) |
| `apiReferenceOnly` | No | Retrieve only API documentation |
| `codeOnly` | No | Retrieve only code examples |

## Setup for Claude Code

To use the Arcium MCP server with Claude Code, add to your MCP configuration:

```json
{
  "mcpServers": {
    "arcium-docs": {
      "url": "https://docs.arcium.com/mcp"
    }
  }
}
```

## Usage Examples

Once configured, you can ask Claude to search Arcium docs:

- "Search Arcium docs for encryption patterns"
- "Find code examples for callback handling in Arcium"
- "Look up ArgBuilder API reference"

## What You Can Search

- Implementation details
- Feature functionality explanations
- Code samples and examples
- API specifications
- Best practices
- Migration guides

## Results Format

Results include:
- Contextual content
- Page titles
- Direct documentation links

## Alternative: Local Docs

This project includes local copies of key Arcium documentation in `/docs/arcium/` for offline reference and faster access. The MCP server provides real-time access to the latest documentation.

## Full Documentation Index

For a complete list of all available documentation pages:
https://docs.arcium.com/llms.txt
