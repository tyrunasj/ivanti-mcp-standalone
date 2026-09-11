import { describe, expect, it } from 'vitest';
import { looksLikeCsdl, parseCsdl, visibleFields } from './csdl.js';

const doc = (schema: string, prefix = 'edmx:'): string =>
  `<?xml version="1.0" encoding="utf-8"?><${prefix}Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><${prefix}DataServices><Schema Namespace="MetaData" xmlns="http://docs.oasis-open.org/odata/ns/edm">${schema}</Schema></${prefix}DataServices></${prefix}Edmx>`;

const INCIDENT = doc(`
  <EntityType Name="incident">
    <Key><PropertyRef Name="RecId" /></Key>
    <Property Name="RecId" Type="Edm.String" Nullable="false" MaxLength="32" Unicode="false" />
    <Property Name="Subject" Type="Edm.String" MaxLength="300" />
    <Property Name="Owner" Type="Edm.String" MaxLength="200" />
    <Property Name="Owner_Valid" Type="Edm.String" MaxLength="32" Unicode="false" />
    <Property Name="nrn_CostType_Valid" Type="Edm.String" MaxLength="32" Unicode="false" />
    <NavigationProperty Name="IncidentContainsTask" Type="Collection(MetaData.task)" />
    <NavigationProperty Name="IncidentOwner" Type="MetaData.employee" />
  </EntityType>
  <EntityType Name="task">
    <Property Name="RecId" Type="Edm.String" Nullable="false" MaxLength="32" Unicode="false" />
  </EntityType>`);

describe('looksLikeCsdl', () => {
  it('accepts prefixed and unprefixed Edmx, rejects anything else', () => {
    expect(looksLikeCsdl('<edmx:Edmx Version="4.0">')).toBe(true);
    expect(looksLikeCsdl('<Edmx>')).toBe(true);
    expect(looksLikeCsdl('<html><body>Sign in</body></html>')).toBe(false);
    expect(looksLikeCsdl('')).toBe(false);
  });
});

describe('parseCsdl', () => {
  it('keys entities by lowercase name, whatever the namespace prefix', () => {
    expect([...parseCsdl(INCIDENT).entities.keys()]).toEqual(['incident', 'task']);
    expect([...parseCsdl(doc('<EntityType Name="incident"><Property Name="RecId" Type="Edm.String" /></EntityType>', '').replace(/edmx:/g, '')).entities.keys()]).toEqual(['incident']);
  });

  it('reads fields, treating an absent Nullable as nullable', () => {
    const incident = parseCsdl(INCIDENT).entities.get('incident');

    expect(incident?.fields.find((f) => f.name === 'Subject')).toMatchObject({
      type: 'Edm.String',
      nullable: true,
    });
    expect(incident?.fields.find((f) => f.name === 'RecId')?.nullable).toBe(false);
  });

  it('marks a field with a _Valid twin as validated, and hides the twin', () => {
    const incident = parseCsdl(INCIDENT).entities.get('incident');

    expect(incident?.fields.find((f) => f.name === 'Owner')?.validated).toBe(true);
    expect(incident?.fields.find((f) => f.name === 'Owner_Valid')?.internalTwin).toBe(true);
    expect(visibleFields(incident!).map((f) => f.name)).not.toContain('Owner_Valid');
  });

  it('keeps an ORPHAN twin visible — it is the only evidence the field is validated', () => {
    const incident = parseCsdl(INCIDENT).entities.get('incident');

    // nrn_CostType does not exist on this entity, so nrn_CostType_Valid has no stand-in.
    expect(visibleFields(incident!).map((f) => f.name)).toContain('nrn_CostType_Valid');
  });

  it('extracts relationship targets from collection and single-valued navigation', () => {
    const incident = parseCsdl(INCIDENT).entities.get('incident');

    expect(incident?.relationships).toEqual([
      { name: 'IncidentContainsTask', target: 'task' },
      { name: 'IncidentOwner', target: 'employee' },
    ]);
  });

  it('reads a CSDL 3 ToRole relationship', () => {
    const legacy = doc(`<EntityType Name="incident">
      <Property Name="RecId" Type="Edm.String" />
      <NavigationProperty Name="Owner" Relationship="MetaData.Rel" ToRole="employee" />
    </EntityType>`);

    expect(parseCsdl(legacy).entities.get('incident')?.relationships).toEqual([
      { name: 'Owner', target: 'employee' },
    ]);
  });

  it('drops the field-less entity Ivanti fabricates for a name that does not exist', () => {
    const fabricated = doc('<EntityType Name="nonexistent" />');

    // 200, valid CSDL, an EntitySet to match — and no fields. Measured live.
    expect(() => parseCsdl(fabricated)).toThrow(/no entity types with fields/);
  });

  it('refuses anything that is not CSDL rather than caching an empty schema', () => {
    expect(() => parseCsdl('<html><body>Sign in</body></html>')).toThrow(/Expected a CSDL/);
  });
});
