---
name: write-unit-test
description: Write a unit test for a given function or module
when_to_use: When the user wants to add tests, improve coverage, or test a specific function
categories: [testing, code-quality]
---
# Write Unit Test

## Required params
- file path, function name

## Steps
1. Read the target file and function
2. Identify inputs, outputs, and edge cases
3. Write test using the project's test framework (pytest/jest/vitest)
4. Include: happy path, edge cases, error cases
5. Run the test to verify it passes
6. Report coverage if available

## Example
User: "Write a test for the parseDate function"
→ Read file → identify edge cases → write pytest test → run → report