import { JSONSchema7 as IJsonSchema } from "json-schema";
import { OpenAPIV3 } from "openapi-types";
import { describe, expect, it } from "vitest";
import { OpenAPIToMCPConverter } from "../parser";

describe("Filter support", () => {
  describe("FilterExpression schema resolution", () => {
    it("should resolve FilterExpression $ref to a proper schema instead of empty object", () => {
      const converter = new OpenAPIToMCPConverter({
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
        paths: {},
        components: {
          schemas: {
            FilterExpression: {
              type: "object",
              properties: {
                operator: { $ref: "#/components/schemas/FilterOperator" },
                conditions: { type: "array", items: { $ref: "#/components/schemas/FilterItem" } },
                filters: { type: "array", items: { $ref: "#/components/schemas/FilterExpression" } },
              },
            },
          },
        },
      } as OpenAPIV3.Document);

      const schema = converter.convertOpenApiSchemaToJsonSchema(
        { $ref: "#/components/schemas/FilterExpression" },
        new Set(),
      );

      // Should NOT be an empty object
      expect(schema).not.toEqual({});
      expect(schema.type).toBe("object");
      expect(schema.properties).toBeDefined();
    });

    it("should produce FilterExpression with operator, conditions, and filters fields", () => {
      const converter = new OpenAPIToMCPConverter({
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
        paths: {},
      } as OpenAPIV3.Document);

      const schema = converter.convertOpenApiSchemaToJsonSchema(
        { $ref: "#/components/schemas/FilterExpression" },
        new Set(),
      );

      const props = schema.properties as Record<string, IJsonSchema>;
      expect(props).toBeDefined();

      // operator
      expect(props.operator).toBeDefined();
      expect(props.operator.enum).toEqual(["and", "or"]);

      // conditions
      expect(props.conditions).toBeDefined();
      expect(props.conditions.type).toBe("array");
      const conditionItem = props.conditions.items as IJsonSchema;
      expect(conditionItem.type).toBe("object");

      // filters (nested)
      expect(props.filters).toBeDefined();
      expect(props.filters.type).toBe("array");
    });

    it("should include all filter condition value fields in FilterItem", () => {
      const converter = new OpenAPIToMCPConverter({
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
        paths: {},
      } as OpenAPIV3.Document);

      const schema = converter.convertOpenApiSchemaToJsonSchema(
        { $ref: "#/components/schemas/FilterExpression" },
        new Set(),
      );

      const conditionItem = (schema.properties as Record<string, IJsonSchema>).conditions.items as IJsonSchema;
      const itemProps = conditionItem.properties as Record<string, IJsonSchema>;

      // Required fields
      expect(itemProps.property_key).toBeDefined();
      expect(itemProps.property_key.type).toBe("string");
      expect(itemProps.condition).toBeDefined();
      expect(itemProps.condition.enum).toBeDefined();
      expect((itemProps.condition.enum as string[]).length).toBeGreaterThanOrEqual(17);

      // All value type fields
      expect(itemProps.text?.type).toBe("string");
      expect(itemProps.number?.type).toBe("number");
      expect(itemProps.select?.type).toBe("string");
      expect(itemProps.multi_select?.type).toBe("array");
      expect(itemProps.date?.type).toBe("string");
      expect(itemProps.checkbox?.type).toBe("boolean");
      expect(itemProps.url?.type).toBe("string");
      expect(itemProps.email?.type).toBe("string");
      expect(itemProps.phone?.type).toBe("string");
      expect(itemProps.objects?.type).toBe("array");
      expect(itemProps.files?.type).toBe("array");
    });

    it("should include all 17 filter condition operators", () => {
      const converter = new OpenAPIToMCPConverter({
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
        paths: {},
      } as OpenAPIV3.Document);

      const schema = converter.convertOpenApiSchemaToJsonSchema(
        { $ref: "#/components/schemas/FilterExpression" },
        new Set(),
      );

      const conditionItem = (schema.properties as Record<string, IJsonSchema>).conditions.items as IJsonSchema;
      const conditionEnum = (conditionItem.properties as Record<string, IJsonSchema>).condition.enum as string[];

      const expectedConditions = [
        "equal",
        "not_equal",
        "greater",
        "less",
        "greater_or_equal",
        "less_or_equal",
        "like",
        "not_like",
        "in",
        "not_in",
        "empty",
        "not_empty",
        "all_in",
        "not_all_in",
        "exact_in",
        "not_exact_in",
        "exists",
      ];

      for (const cond of expectedConditions) {
        expect(conditionEnum).toContain(cond);
      }
    });
  });

  describe("search tools include filters", () => {
    const createSpecWithSearch = (): OpenAPIV3.Document =>
      ({
        openapi: "3.0.0",
        info: { title: "Anytype API", version: "1.0.0" },
        paths: {
          "/v1/spaces/{space_id}/search": {
            post: {
              operationId: "search_space",
              summary: "Search objects in space",
              parameters: [
                { name: "space_id", in: "path", required: true, schema: { type: "string" } },
              ],
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        query: { type: "string" },
                        filters: { $ref: "#/components/schemas/FilterExpression" },
                        sorts: { type: "array", items: { type: "object" } },
                      },
                    },
                  },
                },
              },
              responses: { "200": { description: "Success" } },
            },
          },
        },
        components: {
          schemas: {
            FilterExpression: {
              type: "object",
              properties: {
                operator: { $ref: "#/components/schemas/FilterOperator" },
                conditions: { type: "array", items: { $ref: "#/components/schemas/FilterItem" } },
                filters: { type: "array", items: { $ref: "#/components/schemas/FilterExpression" } },
              },
            },
          },
        },
      }) as OpenAPIV3.Document;

    it("should include filters property in search tool input schema", () => {
      const converter = new OpenAPIToMCPConverter(createSpecWithSearch());
      const { tools } = converter.convertToMCPTools();

      const searchTool = tools["API"]?.methods.find((m) => m.name.includes("search"));
      expect(searchTool).toBeDefined();

      const inputProps = searchTool!.inputSchema.properties as Record<string, IJsonSchema>;
      expect(inputProps.filters).toBeDefined();
      expect(inputProps.filters.type).toBe("object");
      expect(inputProps.filters.properties).toBeDefined();
    });

    it("should not strip filters from required array", () => {
      const spec = createSpecWithSearch();
      // Make filters required in the spec
      const bodySchema = (spec.paths["/v1/spaces/{space_id}/search"] as any).post.requestBody.content[
        "application/json"
      ].schema;
      bodySchema.required = ["query", "filters"];

      const converter = new OpenAPIToMCPConverter(spec);
      const { tools } = converter.convertToMCPTools();

      const searchTool = tools["API"]?.methods.find((m) => m.name.includes("search"));
      expect(searchTool!.inputSchema.required).toContain("filters");
    });
  });

  describe("non-filter tools remain unaffected", () => {
    it("should not add filters to operations without FilterExpression", () => {
      const converter = new OpenAPIToMCPConverter({
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
        paths: {
          "/v1/spaces/{space_id}/objects/{object_id}": {
            get: {
              operationId: "get_object",
              parameters: [
                { name: "space_id", in: "path", required: true, schema: { type: "string" } },
                { name: "object_id", in: "path", required: true, schema: { type: "string" } },
              ],
              responses: { "200": { description: "Success" } },
            },
          },
        },
      } as OpenAPIV3.Document);

      const { tools } = converter.convertToMCPTools();
      const getTool = tools["API"]?.methods[0];
      const inputProps = getTool!.inputSchema.properties as Record<string, IJsonSchema>;

      expect(inputProps.filters).toBeUndefined();
    });
  });
});
