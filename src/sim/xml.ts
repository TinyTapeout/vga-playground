export class XMLParseError extends Error {}

export interface XMLNode {
  type: string;
  text: string | null;
  children: XMLNode[];
  attrs: { [id: string]: string };
  obj: any;
}

export type XMLVisitFunction = (node: XMLNode) => any;

function escapeXML(s: string): string {
  if (s.indexOf('&') >= 0) {
    return s
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&');
  } else {
    return s;
  }
}

export function parseXMLPoorly(
  s: string,
  openfn?: XMLVisitFunction,
  closefn?: XMLVisitFunction
): XMLNode {
  const tag_re = /[<]([/]?)([?a-z_-]+)([^>]*)[>]+|(\s*[^<]+)/gi;
  const attr_re = /\s*(\w+)="(.*?)"\s*/gi;
  let fm: RegExpMatchArray | null;
  const stack: XMLNode[] = [];
  let top: XMLNode | undefined;

  function closetop() {
    top = stack.pop();
    if (top == null || top.type != ident) throw new XMLParseError('mismatch close tag: ' + ident);
    if (closefn) {
      top.obj = closefn(top);
    }
    if (stack.length == 0) throw new XMLParseError('close tag without open: ' + ident);
    stack[stack.length - 1].children.push(top);
  }
  function parseattrs(as: string): { [id: string]: string } {
    var am;
    var attrs = {};
    if (as != null) {
      while ((am = attr_re.exec(as))) {
        attrs[am[1]] = escapeXML(am[2]);
      }
    }
    return attrs;
  }
  while ((fm = tag_re.exec(s))) {
    var [_m0, close, ident, attrs, content] = fm;
    //console.log(stack.length, close, ident, attrs, content);
    if (close) {
      closetop();
    } else if (ident) {
      var node = { type: ident, text: null, children: [], attrs: parseattrs(attrs), obj: null };
      stack.push(node);
      if (attrs) {
        parseattrs(attrs);
      }
      if (openfn) {
        node.obj = openfn(node);
      }
      if (attrs && attrs.endsWith('/')) closetop();
    } else if (content != null) {
      if (stack.length == 0) throw new XMLParseError('content without element');
      var txt = escapeXML(content as string).trim();
      if (txt.length) stack[stack.length - 1].text = txt;
    }
  }
  if (stack.length != 1) throw new XMLParseError('tag not closed');
  if (stack[0].type != '?xml') throw new XMLParseError('?xml needs to be first element');
  if (!top) throw new XMLParseError('no top');
  return top;
}
