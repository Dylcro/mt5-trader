import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mt5Router from "./mt5";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mt5Router);

export default router;
