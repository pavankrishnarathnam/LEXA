import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "@/components/ui/misc";
import { Field, Input } from "@/components/ui/input";

describe("components", () => {
  it("renders task status labels", () => {
    render(<StatusBadge status="WAITING_FOR_APPROVAL" />);
    expect(screen.getByText("Needs approval")).toBeTruthy();
  });
  it("Field always labels its control (accessibility)", () => {
    render(<Field label="Email"><Input /></Field>);
    expect(screen.getByLabelText("Email").tagName).toBe("INPUT");
  });
});
