export interface XmlTextNode {
  type: "text";
  content: string;
}

export interface XmlElementNode {
  type: "element";
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElementNode | XmlTextNode;

export function parseXmlDocument(raw: string): XmlElementNode {
  const tokens = raw.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[^>]+>|[^<]+/g) ?? [];
  const rootStack: XmlElementNode[] = [];
  let root: XmlElementNode | undefined;

  for (const token of tokens) {
    if (token.startsWith("<?") || token.startsWith("<!--")) {
      continue;
    }
    if (token.startsWith("<![CDATA[")) {
      appendText(rootStack[rootStack.length - 1], token.slice(9, -3));
      continue;
    }
    if (token.startsWith("</")) {
      rootStack.pop();
      continue;
    }
    if (token.startsWith("<")) {
      const element = parseElementToken(token);
      if (!root) {
        root = element.node;
      }
      const parent = rootStack[rootStack.length - 1];
      if (parent) {
        parent.children.push(element.node);
      }
      if (!element.selfClosing) {
        rootStack.push(element.node);
      }
      continue;
    }
    appendText(rootStack[rootStack.length - 1], token);
  }

  if (!root) {
    throw new Error("Invalid XML document.");
  }
  return root;
}

export function cloneElement<T extends XmlElementNode>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T;
}

export function serializeXmlDocument(root: XmlElementNode): string {
  return `${serializeNode(root, 0)}\n`;
}

export function localName(name: string): string {
  return name.includes(":") ? name.split(":").pop() ?? name : name;
}

export function childElements(node: XmlElementNode, name?: string): XmlElementNode[] {
  const elements = node.children.filter((child): child is XmlElementNode => child.type === "element");
  if (!name) {
    return elements;
  }
  return elements.filter((child) => localName(child.name) === name);
}

export function firstChild(node: XmlElementNode, name: string): XmlElementNode | undefined {
  return childElements(node, name)[0];
}

export function ensureChild(node: XmlElementNode, name: string): XmlElementNode {
  const existing = firstChild(node, name);
  if (existing) {
    return existing;
  }
  const child: XmlElementNode = {
    type: "element",
    name,
    attributes: {},
    children: [],
  };
  node.children.push(child);
  return child;
}

export function textContent(node: XmlElementNode): string {
  return node.children
    .filter((child): child is XmlTextNode => child.type === "text")
    .map((child) => child.content)
    .join("")
    .trim();
}

export function setTextContent(node: XmlElementNode, value: string): void {
  node.children = [{ type: "text", content: value }];
}

export function removeChild(node: XmlElementNode, child: XmlElementNode): void {
  const index = node.children.indexOf(child);
  if (index !== -1) {
    node.children.splice(index, 1);
  }
}

export function walkElements(node: XmlElementNode, visit: (element: XmlElementNode) => void): void {
  visit(node);
  for (const child of childElements(node)) {
    walkElements(child, visit);
  }
}

function parseElementToken(token: string): { node: XmlElementNode; selfClosing: boolean } {
  const inner = token.slice(1, token.endsWith("/>") ? -2 : -1).trim();
  const spaceIndex = inner.search(/\s/);
  const name = spaceIndex === -1 ? inner : inner.slice(0, spaceIndex);
  const attributesSource = spaceIndex === -1 ? "" : inner.slice(spaceIndex + 1);
  const attributes: Record<string, string> = {};
  for (const match of attributesSource.matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]!] = match[3] ?? match[4] ?? "";
  }
  return {
    node: {
      type: "element",
      name,
      attributes,
      children: [],
    },
    selfClosing: token.endsWith("/>"),
  };
}

function appendText(parent: XmlElementNode | undefined, value: string): void {
  if (!parent) {
    return;
  }
  if (value.trim().length === 0) {
    return;
  }
  parent.children.push({ type: "text", content: value });
}

function serializeNode(node: XmlNode, depth: number): string {
  if (node.type === "text") {
    return `${"  ".repeat(depth)}${escapeXml(node.content.trim())}`;
  }
  const attributes = Object.entries(node.attributes)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join("");
  if (node.children.length === 0) {
    return `${"  ".repeat(depth)}<${node.name}${attributes}/>`;
  }
  const onlyText = node.children.length === 1 && node.children[0]?.type === "text";
  if (onlyText) {
    return `${"  ".repeat(depth)}<${node.name}${attributes}>${escapeXml((node.children[0] as XmlTextNode).content.trim())}</${node.name}>`;
  }
  const body = node.children.map((child) => serializeNode(child, depth + 1)).join("\n");
  return `${"  ".repeat(depth)}<${node.name}${attributes}>\n${body}\n${"  ".repeat(depth)}</${node.name}>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
