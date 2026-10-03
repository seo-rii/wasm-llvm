module invalid;

fn int broken() @wasm("broken")
{
	return missing_value;
}
