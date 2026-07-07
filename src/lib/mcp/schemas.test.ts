import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createTodoInput,
	deleteTodoInput,
	listTeamsInput,
	listTodosInput,
	updateTodoInput,
} from "./schemas";

// The schemas are exported as zod "raw shapes"; wrap them to validate.
describe("mcp tool input schemas", () => {
	it("list_teams: org_id is optional", () => {
		const schema = z.object(listTeamsInput);
		expect(schema.parse({})).toEqual({});
		expect(schema.parse({ org_id: "org1" })).toEqual({ org_id: "org1" });
	});

	it("list_todos: team_id is required", () => {
		const schema = z.object(listTodosInput);
		expect(schema.parse({ team_id: "t1" })).toEqual({ team_id: "t1" });
		expect(() => schema.parse({})).toThrow();
	});

	it("create_todo: requires team_id and non-empty title", () => {
		const schema = z.object(createTodoInput);
		expect(
			schema.parse({ team_id: "t1", title: "buy milk" }),
		).toMatchObject({ team_id: "t1", title: "buy milk" });
		expect(() => schema.parse({ team_id: "t1", title: "" })).toThrow();
		expect(() => schema.parse({ title: "x" })).toThrow();
	});

	it("update_todo: todo_id required, assignee_id nullable", () => {
		const schema = z.object(updateTodoInput);
		expect(schema.parse({ todo_id: 1, done: true })).toMatchObject({
			todo_id: 1,
			done: true,
		});
		expect(schema.parse({ todo_id: 1, assignee_id: null })).toMatchObject({
			assignee_id: null,
		});
		expect(() => schema.parse({ todo_id: "1" })).toThrow();
	});

	it("delete_todo: todo_id must be a number", () => {
		const schema = z.object(deleteTodoInput);
		expect(schema.parse({ todo_id: 5 })).toEqual({ todo_id: 5 });
		expect(() => schema.parse({ todo_id: "5" })).toThrow();
	});
});
