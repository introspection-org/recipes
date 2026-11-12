//! Source locations for `package.json` diagnostics, so a host can point at the
//! line a rule is about. serde_json keeps no positions, so this walks the text.

use crate::Span;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    Key(String),
    Index(usize),
}

/// The span of the value a `package.json` diagnostic names, read from its
/// message: `package.json#pi.mcp.servers[0].tools …`, and the key itself when
/// it says `unknown key 'x'`, `unknown field 'x'` or `unknown tool 'x'`.
/// Falls back to the nearest enclosing key that exists.
pub(crate) fn package_json_span(source: &str, message: &str) -> Option<Span> {
    let mut path = message_path(message)?;
    for marker in ["unknown key '", "unknown field '", "unknown tool '"] {
        if let Some(start) = message.find(marker) {
            let rest = &message[start + marker.len()..];
            if let Some(end) = rest.find('\'') {
                path.push(Segment::Key(rest[..end].to_owned()));
            }
            break;
        }
    }
    let members = members(source)?;
    (1..=path.len()).rev().find_map(|len| {
        members
            .iter()
            .find(|(member, _)| member.as_slice() == &path[..len])
            .map(|(_, offset)| span_at(source, *offset))
    })
}

fn message_path(message: &str) -> Option<Vec<Segment>> {
    let start = message.find("package.json#")? + "package.json#".len();
    let token = message[start..]
        .split(char::is_whitespace)
        .next()?
        .trim_end_matches([':', ',', '.']);
    let mut path = Vec::new();
    for part in token.split('.') {
        let (key, mut indexes) = match part.find('[') {
            Some(open) => (&part[..open], &part[open..]),
            None => (part, ""),
        };
        if key.is_empty() {
            return (!path.is_empty()).then_some(path);
        }
        path.push(Segment::Key(key.to_owned()));
        while let Some(rest) = indexes.strip_prefix('[') {
            let close = rest.find(']')?;
            path.push(Segment::Index(rest[..close].parse().ok()?));
            indexes = &rest[close + 1..];
        }
    }
    (!path.is_empty()).then_some(path)
}

/// Every object member and array element in `source`, with the byte offset of
/// its key (or, for an element, its value). `None` when the text isn't JSON.
fn members(source: &str) -> Option<Vec<(Vec<Segment>, usize)>> {
    let mut walker = Walker {
        bytes: source.as_bytes(),
        source,
        pos: 0,
        found: Vec::new(),
    };
    walker.value(&mut Vec::new())?;
    Some(walker.found)
}

struct Walker<'a> {
    bytes: &'a [u8],
    source: &'a str,
    pos: usize,
    found: Vec<(Vec<Segment>, usize)>,
}

impl Walker<'_> {
    fn skip_whitespace(&mut self) {
        while self
            .bytes
            .get(self.pos)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.pos += 1;
        }
    }

    fn value(&mut self, path: &mut Vec<Segment>) -> Option<()> {
        self.skip_whitespace();
        match *self.bytes.get(self.pos)? {
            b'{' => self.object(path),
            b'[' => self.array(path),
            b'"' => self.string().map(drop),
            _ => {
                while self
                    .bytes
                    .get(self.pos)
                    .is_some_and(|b| !matches!(b, b',' | b'}' | b']') && !b.is_ascii_whitespace())
                {
                    self.pos += 1;
                }
                Some(())
            }
        }
    }

    fn object(&mut self, path: &mut Vec<Segment>) -> Option<()> {
        self.pos += 1;
        loop {
            self.skip_whitespace();
            match *self.bytes.get(self.pos)? {
                b'}' => {
                    self.pos += 1;
                    return Some(());
                }
                b',' => self.pos += 1,
                b'"' => {
                    let offset = self.pos;
                    let key = self.string()?;
                    self.skip_whitespace();
                    (self.bytes.get(self.pos)? == &b':').then_some(())?;
                    self.pos += 1;
                    path.push(Segment::Key(key));
                    self.found.push((path.clone(), offset));
                    self.value(path)?;
                    path.pop();
                }
                _ => return None,
            }
        }
    }

    fn array(&mut self, path: &mut Vec<Segment>) -> Option<()> {
        self.pos += 1;
        let mut index = 0;
        loop {
            self.skip_whitespace();
            match *self.bytes.get(self.pos)? {
                b']' => {
                    self.pos += 1;
                    return Some(());
                }
                b',' => self.pos += 1,
                _ => {
                    path.push(Segment::Index(index));
                    self.found.push((path.clone(), self.pos));
                    self.value(path)?;
                    path.pop();
                    index += 1;
                }
            }
        }
    }

    fn string(&mut self) -> Option<String> {
        let start = self.pos;
        self.pos += 1;
        loop {
            match *self.bytes.get(self.pos)? {
                b'\\' => self.pos += 2,
                b'"' => {
                    self.pos += 1;
                    return serde_json::from_str(&self.source[start..self.pos]).ok();
                }
                _ => self.pos += 1,
            }
        }
    }
}

fn span_at(source: &str, offset: usize) -> Span {
    let before = &source[..offset];
    let line = before.matches('\n').count() + 1;
    let column = before
        .rsplit('\n')
        .next()
        .map_or(0, |text| text.chars().count())
        + 1;
    Span { line, column }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PACKAGE: &str = r#"{
  "name": "demo",
  "pi": {
    "mcp": {
      "servers": [
        { "id": "a" },
        {
          "id": "b",
          "tools": { "include": ["*"] }
        }
      ]
    },
    "signature": [{ "provider": "docusign" }]
  }
}
"#;

    fn span(message: &str) -> Option<(usize, usize)> {
        package_json_span(PACKAGE, message).map(|span| (span.line, span.column))
    }

    #[test]
    fn points_at_an_unknown_key() {
        assert_eq!(
            span("package.json#pi contains unknown key 'signature'"),
            Some((13, 5))
        );
    }

    #[test]
    fn follows_indexes_and_nested_keys() {
        assert_eq!(
            span("package.json#pi.mcp.servers[1].tools must be an object"),
            Some((9, 11))
        );
        assert_eq!(
            span("package.json#pi.mcp.servers[0] must be an object"),
            Some((6, 9))
        );
    }

    #[test]
    fn falls_back_to_the_nearest_key_that_exists() {
        assert_eq!(
            span("package.json#pi.mcp.servers[1] contains unknown field 'mode'"),
            Some((7, 9))
        );
        assert_eq!(
            span("package.json#pi.evals contains unknown key 'x'"),
            Some((3, 3))
        );
    }

    #[test]
    fn needs_a_path_and_json() {
        assert_eq!(span("packageManager must be pnpm@<version>"), None);
        assert_eq!(package_json_span("{ not json", "package.json#pi"), None);
    }
}
