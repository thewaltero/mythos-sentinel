export function toSarif(report) {
  const rules = new Map();
  for (const finding of report.findings) {
    if (!rules.has(finding.id)) {
      rules.set(finding.id, {
        id: finding.id,
        name: finding.title,
        shortDescription: { text: finding.title },
        fullDescription: { text: finding.recommendation },
        properties: { category: finding.category, tags: finding.tags || [], severity: finding.severity }
      });
    }
  }

  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'Mythos Sentinel',
            informationUri: 'https://github.com/thewaltero/mythos-sentinel',
            rules: [...rules.values()]
          }
        },
        results: report.findings.map((finding) => ({
          ruleId: finding.id,
          level: sarifLevel(finding.severity),
          message: { text: `${finding.title}. ${finding.recommendation}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: finding.file },
                region: { startLine: finding.line || 1 }
              }
            }
          ],
          properties: { severity: finding.severity, category: finding.category, evidence: finding.evidence }
        }))
      }
    ]
  };
}

function sarifLevel(severity) {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'note';
}
