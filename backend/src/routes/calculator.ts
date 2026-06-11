// src/routes/calculator.ts
import { Router } from "express";
import type { Request, Response } from "express";
import { calculatorService } from "../services/calculator.service.js";

export const calculatorRouter: Router = Router();

calculatorRouter.post("/convert", async (req: Request, res: Response) => {
  try {
    const { amount } = req.body;
    if (!amount || isNaN(Number(amount))) {
      res.status(400).json({ error: "invalid_amount" });
      return;
    }
    
    const result = await calculatorService.convertCurrency(Number(amount));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || "server_error" });
  }
});